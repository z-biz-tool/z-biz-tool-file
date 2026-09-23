//! 水印端到端：真实 PDF 的形状（内容流 Flate 压缩 + 三层页树 + Resources 挂在祖先）
//!
//! 单元测试用的是最简文档，这里补上生产 PDF 才有的三件事：
//! 1. /Contents 是压缩流 —— 追加策略必须完全不碰原流，连解压一次都不该做；
//! 2. MediaBox 挂在中间 Pages 节点上，叶子页靠继承拿尺寸；
//! 3. 资源写进祖先 Resources 后，祖先下面每一页都得能解析到 /Fwm。

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use z_biz_tool_file_lib::test_bridge::{call_watermark_pdf, TempDir};

fn name(value: &str) -> Object {
    Object::Name(value.as_bytes().to_vec())
}

/// 根 Pages（带 Resources） → 中层 Pages（带 MediaBox） → 叶子页，正文压缩
fn compressed_fixture(dir: &std::path::Path) -> std::path::PathBuf {
    let mut doc = Document::new();
    let font = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Font"));
        dict.set("Subtype", name("Type1"));
        dict.set("BaseFont", name("Helvetica"));
        dict
    }));
    let root_resources = doc.add_object(Object::Dictionary({
        let mut fonts = Dictionary::new();
        fonts.set(b"F1".to_vec(), Object::Reference(font));
        let mut dict = Dictionary::new();
        dict.set("Font", Object::Dictionary(fonts));
        dict
    }));

    let mut body = |label: &str| {
        doc.add_object(Object::Stream(Stream::new(
            Dictionary::new(),
            // 撑到几千字节，否则 lopdf 的 compress() 认为"压缩不划算"而跳过，
            // 夹具就不是真实 PDF 的形态了
            format!(
                "BT /F1 18 Tf 60 700 Td ({}) Tj ET\n% {}\n",
                label,
                "pad ".repeat(1000)
            )
            .into_bytes(),
        )))
    };
    let first = body("Body One");
    let second = body("Body Two");

    let mut page = |stream: ObjectId| {
        doc.add_object(Object::Dictionary({
            let mut dict = Dictionary::new();
            dict.set("Type", name("Page"));
            dict.set("Contents", Object::Reference(stream));
            dict
        }))
    };
    let page_one = page(first);
    let page_two = page(second);

    let mid = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Pages"));
        dict.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(500),
                Object::Integer(700),
            ]),
        );
        dict.set("Kids", Object::Array(vec![
            Object::Reference(page_one),
            Object::Reference(page_two),
        ]));
        dict.set("Count", Object::Integer(2));
        dict
    }));
    for id in [page_one, page_two] {
        let dict = doc.get_object_mut(id).unwrap().as_dict_mut().unwrap();
        dict.set("Parent", Object::Reference(mid));
    }

    let root = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Pages"));
        dict.set("Kids", Object::Array(vec![Object::Reference(mid)]));
        dict.set("Count", Object::Integer(2));
        dict.set("Resources", Object::Reference(root_resources));
        dict
    }));
    let catalog = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Catalog"));
        dict.set("Pages", Object::Reference(root));
        dict
    }));
    doc.trailer.set("Root", Object::Reference(catalog));
    // 生产 PDF 的正文几乎都是 Flate 压缩的，这一步让 /Contents 带上 /Filter
    doc.compress();
    let path = dir.join("compressed.pdf");
    doc.save(&path).unwrap();
    path
}

fn contents_of(doc: &Document, page: ObjectId) -> Vec<Object> {
    let value = doc
        .get_object(page)
        .ok()
        .and_then(|object| object.as_dict().ok())
        .and_then(|dict| dict.get(b"Contents").ok())
        .cloned()
        .expect("页面应有 Contents");
    match value {
        Object::Array(items) => items,
        single => vec![single],
    }
}

fn stream_of(doc: &Document, object: &Object) -> lopdf::Stream {
    let id = object
        .as_reference()
        .unwrap_or_else(|_| panic!("Contents 项应为引用，实际 {:?}", object));
    doc.get_object(id)
        .ok()
        .and_then(|object| object.as_stream().ok())
        .cloned()
        .expect("Contents 引用应指向流")
}

/// 页面 → 祖先逐层找 Resources，再取其中的一个键
fn inherited(doc: &Document, page: ObjectId, group: &[u8], key: &[u8]) -> Object {
    let mut current = page;
    for _ in 0..32 {
        let dict = doc
            .get_object(current)
            .ok()
            .and_then(|object| object.as_dict().ok())
            .cloned()
            .expect("页树引用应有效");
        if let Ok(resources) = dict.get(b"Resources") {
            let resources = match resources {
                Object::Reference(id) => doc
                    .get_object(*id)
                    .ok()
                    .and_then(|object| object.as_dict().ok())
                    .cloned()
                    .expect("Resources 引用应指向字典"),
                Object::Dictionary(inline) => inline.clone(),
                other => panic!("Resources 类型 {:?}", other),
            };
            if let Ok(group_dict) = resources.get(group) {
                let group_dict = match group_dict {
                    Object::Dictionary(dict) => dict.clone(),
                    Object::Reference(id) => doc
                        .get_object(*id)
                        .ok()
                        .and_then(|object| object.as_dict().ok())
                        .cloned()
                        .expect("子字典引用应有效"),
                    other => panic!("{:?} 类型 {:?}", group, other),
                };
                if let Ok(value) = group_dict.get(key) {
                    return value.clone();
                }
            }
        }
        match dict.get(b"Parent").and_then(Object::as_reference).ok() {
            Some(id) => current = id,
            None => break,
        }
    }
    panic!("继承链上找不到 {:?}/{:?}", group, key);
}

#[test]
fn watermark_survives_compressed_content_and_inherited_boxes() {
    let dir = TempDir::new("integ-wm");
    let input = compressed_fixture(&dir);

    // 先确认夹具真的是压缩的，否则这条测试什么都没覆盖
    let before = Document::load(&input).unwrap();
    let original: std::collections::BTreeMap<u32, Vec<u8>> = before
        .get_pages()
        .iter()
        .map(|(number, id)| {
            let items = contents_of(&before, *id);
            let body = stream_of(&before, &items[0]);
            assert_eq!(items.len(), 1);
            assert_eq!(
                body.dict.get(b"Filter").ok().and_then(|f| f.as_name().ok()),
                Some(b"FlateDecode".as_ref()),
                "第 {} 页正文应带 /FlateDecode",
                number
            );
            (*number, body.content.clone())
        })
        .collect();
    assert_eq!(original.len(), 2);

    let output = dir.join("marked.pdf");
    let pages = call_watermark_pdf(
        input.to_str().unwrap(),
        output.to_str().unwrap(),
        "内部资料",
        0.2,
    )
    .expect("水印应成功");
    assert_eq!(pages, 2);

    let doc = Document::load(&output).unwrap();
    let ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    assert_eq!(ids.len(), 2);

    for (index, page) in ids.iter().enumerate() {
        let items = contents_of(&doc, *page);
        assert_eq!(items.len(), 2, "第 {} 页应为原正文 + 追加水印流", index);
        // 原流一个字节都不能动，压缩参数也不该被拆掉
        let body = stream_of(&doc, &items[0]);
        assert_eq!(
            body.content,
            original[&(index as u32 + 1)],
            "第 {} 页正文被改动了",
            index
        );
        assert!(body.dict.get(b"Filter").is_ok());
        // 水印流是非压缩的，直接读得到算符
        let ops = String::from_utf8_lossy(&stream_of(&doc, &items[1]).content).to_string();
        assert!(ops.contains("/Fwm") && ops.contains("Tj"), "{}", ops);
        // 尺寸来自中层继承：500x700 → 中心 250,350
        assert!(ops.contains("1 0 0 1 250.0 350.0 cm"), "{}", ops);
        // /Fwm 挂在祖先 Resources 上，两页都得解析得到
        let font = inherited(&doc, *page, b"Font", b"Fwm").as_reference().unwrap();
        let font = doc.get_object(font).unwrap().as_dict().unwrap().clone();
        assert_eq!(font.get(b"Subtype").unwrap().as_name().unwrap(), b"Type0");
        let state = inherited(&doc, *page, b"ExtGState", b"Gwm")
            .as_reference()
            .unwrap();
        assert_eq!(
            doc.get_object(state)
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"ca")
                .unwrap()
                .as_f32()
                .unwrap(),
            0.2
        );
    }

    // 输入文件不该被改动：正文流数量与内容都保持原样
    let still = Document::load(&input).unwrap();
    for (number, id) in still.get_pages() {
        let items = contents_of(&still, id);
        assert_eq!(items.len(), 1, "输入不应多出水印流");
        assert_eq!(stream_of(&still, &items[0]).content, original[&number]);
    }
}
