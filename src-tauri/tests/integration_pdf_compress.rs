//! 压缩端到端：正文流补 Flate、图片换成 JPEG，并且要在"生产 PDF 的形状"下成立
//!
//! 单元测试只看最简文档，这里补三件真事：
//! 1. 页树是分层的，图片资源挂在祖先 Pages 上 —— 改写后每一页仍要解析得到那张图；
//! 2. 正文一开始是未压缩的（新建/工具产出的 PDF 常见），compress 这一步得真的补上 Flate，
//!    而且解压回去算符一个不少，否则就是"体积小了、内容废了"；
//! 3. 输入文件必须逐字节不变 —— 压缩只在副本上做。

use flate2::read::ZlibDecoder;
use image::ImageReader;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::io::Read;
use std::path::Path;
use z_biz_tool_file_lib::test_bridge::{call_compress_pdf, TempDir};

fn name(value: &str) -> Object {
    Object::Name(value.as_bytes().to_vec())
}

fn gradient(width: u32, height: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&[
                (x * 255 / (width - 1)) as u8,
                (y * 255 / (height - 1)) as u8,
                90,
            ]);
        }
    }
    data
}

/// 图片挂在祖先 Resources 上，正文留成未压缩流
fn fixture(dir: &Path) -> std::path::PathBuf {
    let mut doc = Document::new();

    let mut image_dict = Dictionary::new();
    image_dict.set("Type", name("XObject"));
    image_dict.set("Subtype", name("Image"));
    image_dict.set("Width", Object::Integer(240));
    image_dict.set("Height", Object::Integer(160));
    image_dict.set("BitsPerComponent", Object::Integer(8));
    image_dict.set("ColorSpace", name("DeviceRGB"));
    let picture = doc.add_object(Object::Stream(Stream::new(
        image_dict,
        gradient(240, 160),
    )));

    let mut xobjects = Dictionary::new();
    xobjects.set(b"Im0".to_vec(), Object::Reference(picture));
    let resources = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("XObject", Object::Dictionary(xobjects));
        dict
    }));

    let body = doc.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        format!(
            "q 200 0 0 140 40 40 cm /Im0 Do Q\nBT /F1 18 Tf 40 200 Td (hello body) Tj ET\n% {}\n",
            "pad ".repeat(600)
        )
        .into_bytes(),
    )));

    let mut kids: Vec<ObjectId> = Vec::new();
    for _ in 0..2 {
        let mut dict = Dictionary::new();
        dict.set("Type", name("Page"));
        dict.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(300),
                Object::Integer(300),
            ]),
        );
        dict.set("Contents", Object::Reference(body));
        kids.push(doc.add_object(Object::Dictionary(dict)));
    }
    let pages = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Pages"));
        dict.set(
            "Kids",
            Object::Array(kids.iter().copied().map(Object::Reference).collect()),
        );
        dict.set("Count", Object::Integer(2));
        // 资源只在祖先上出现一次
        dict.set("Resources", Object::Reference(resources));
        dict
    }));
    // 真实 PDF 的叶子页都带 /Parent，继承链靠它走
    for id in &kids {
        doc.get_object_mut(*id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Parent", Object::Reference(pages));
    }
    let catalog = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Catalog"));
        dict.set("Pages", Object::Reference(pages));
        dict
    }));
    doc.trailer.set("Root", Object::Reference(catalog));
    let path = dir.join("plain.pdf");
    doc.save(&path).unwrap();
    path
}

fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().values().copied().collect()
}

fn content_stream(doc: &Document, page: ObjectId) -> Stream {
    let value = doc
        .get_object(page)
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"Contents")
        .unwrap()
        .clone();
    // lopdf 的 compress() 会把单条正文改写成 [新流] 数组，两种形态都得认
    let id = match value {
        Object::Array(items) => items[0].as_reference().unwrap(),
        Object::Reference(id) => id,
        Object::Stream(stream) => return stream.clone(),
        other => panic!("Contents 形态意外: {:?}", other),
    };
    doc.get_object(id).unwrap().as_stream().unwrap().clone()
}

fn inflated(stream: &Stream) -> Vec<u8> {
    let filtered = stream
        .dict
        .get(b"Filter")
        .ok()
        .and_then(|value| value.as_name().ok())
        .unwrap_or(b"None")
        .to_vec();
    assert_eq!(filtered, b"FlateDecode", "正文应已被 Flate 压缩");
    let mut out = Vec::new();
    ZlibDecoder::new(&stream.content[..])
        .read_to_end(&mut out)
        .unwrap();
    out
}

fn inherited_image(doc: &Document, page: ObjectId) -> Stream {
    let mut current = Some(page);
    for _ in 0..32 {
        let id = current.expect("页树引用应有效");
        let dict = doc.get_object(id).unwrap().as_dict().unwrap().clone();
        if let Ok(resources) = dict.get(b"Resources") {
            let resources = match resources {
                Object::Reference(id) => doc
                    .get_object(*id)
                    .unwrap()
                    .as_dict()
                    .unwrap()
                    .clone(),
                Object::Dictionary(inline) => inline.clone(),
                other => panic!("Resources 类型 {:?}", other),
            };
            let group = resources.get(b"XObject").unwrap();
            let group = match group {
                Object::Dictionary(dict) => dict.clone(),
                Object::Reference(id) => doc.get_object(*id).unwrap().as_dict().unwrap().clone(),
                other => panic!("XObject 类型 {:?}", other),
            };
            let id = group.get(b"Im0").unwrap().as_reference().unwrap();
            return doc.get_object(id).unwrap().as_stream().unwrap().clone();
        }
        current = dict.get(b"Parent").and_then(Object::as_reference).ok();
    }
    panic!("继承链上找不到 XObject/Im0");
}

#[test]
fn compress_rewrites_body_and_picture_without_touching_the_input() {
    let dir = TempDir::new("integ-compress");
    let input = fixture(&dir);
    let input_bytes = std::fs::read(&input).unwrap();

    // 夹具的前置条件：正文未压缩、图片是原始未压缩样本
    let before = Document::load(&input).unwrap();
    let before_pages = page_ids(&before);
    assert_eq!(before_pages.len(), 2);
    assert!(
        content_stream(&before, before_pages[0])
            .dict
            .get(b"Filter")
            .is_err(),
        "夹具的正文本应未压缩，否则这条测试什么都没覆盖"
    );
    assert_eq!(inherited_image(&before, before_pages[0]).content.len(), 115_200);

    let output = dir.join("tiny.pdf");
    let report = call_compress_pdf(
        input.to_str().unwrap(),
        output.to_str().unwrap(),
        70,
        1_200,
    )
    .expect("压缩应成功");

    assert_eq!(report.rewritten, 1, "{:?}", report.skipped);
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    // 正文流没带滤镜，应当被无损补了一层 Flate
    assert!(report.flated >= 1, "{:?}", report);
    assert_eq!(report.original_size, input_bytes.len() as u64);
    assert_eq!(
        report.new_size,
        std::fs::metadata(&output).unwrap().len(),
        "报告里的体积必须是落盘后的真实大小"
    );
    assert!(
        report.new_size < report.original_size,
        "{} -> {}",
        report.original_size,
        report.new_size
    );

    let doc = Document::load(&output).unwrap();
    let pages = page_ids(&doc);
    assert_eq!(pages.len(), 2);
    for (index, page) in pages.iter().enumerate() {
        // 正文补上了 Flate，且解压回来算符一个不少
        let body = content_stream(&doc, *page);
        let text = inflated(&body);
        let ops = String::from_utf8_lossy(&text).to_string();
        assert!(ops.contains("/Im0 Do"), "第 {} 页丢了贴图算符", index);
        assert!(ops.contains("(hello body) Tj"), "第 {} 页丢了文字", index);
        // 两页共用祖先资源里的同一张图：都得已经是 JPEG
        let picture = inherited_image(&doc, *page);
        assert_eq!(
            picture.dict.get(b"Filter").unwrap().as_name().unwrap(),
            b"DCTDecode"
        );
        assert_eq!(picture.dict.get(b"BitsPerComponent").unwrap().as_i64().unwrap(), 8);
        assert!(picture.dict.get(b"Decode").is_err(), "/Decode 该跟着一起去掉");
        // 换上去的必须真是一张解得开的 JPEG，而且画的还是原图
        let mut cursor = std::io::Cursor::new(&picture.content);
        let decoded = ImageReader::new(&mut cursor)
            .with_guessed_format()
            .unwrap()
            .decode()
            .expect("替换后的图片流不是合法图像");
        assert_eq!((decoded.width(), decoded.height()), (240, 160));
        assert!(!decoded.color().has_alpha());
    }

    // 输入逐字节不变
    assert_eq!(std::fs::read(&input).unwrap(), input_bytes);
}

#[test]
fn compress_reports_why_nothing_could_be_shrunk() {
    let dir = TempDir::new("integ-compress-skip");
    // 只有一张带 SMask 的图：一张都不该动，但命令仍要成功产出副本并说明原因
    let mut doc = Document::new();
    let mut mask_dict = Dictionary::new();
    mask_dict.set("Type", name("XObject"));
    mask_dict.set("Subtype", name("Image"));
    mask_dict.set("Width", Object::Integer(40));
    mask_dict.set("Height", Object::Integer(40));
    mask_dict.set("BitsPerComponent", Object::Integer(8));
    mask_dict.set("ColorSpace", name("DeviceGray"));
    let mask = doc.add_object(Object::Stream(Stream::new(mask_dict, vec![9u8; 1_600])));

    let mut image_dict = Dictionary::new();
    image_dict.set("Type", name("XObject"));
    image_dict.set("Subtype", name("Image"));
    image_dict.set("Width", Object::Integer(40));
    image_dict.set("Height", Object::Integer(40));
    image_dict.set("BitsPerComponent", Object::Integer(8));
    image_dict.set("ColorSpace", name("DeviceRGB"));
    image_dict.set("SMask", Object::Reference(mask));
    let picture = doc.add_object(Object::Stream(Stream::new(image_dict, vec![3u8; 4_800])));

    let mut xobjects = Dictionary::new();
    xobjects.set(b"Im0".to_vec(), Object::Reference(picture));
    let resources = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("XObject", Object::Dictionary(xobjects));
        dict
    }));
    let body = doc.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        b"q 40 0 0 40 0 0 cm /Im0 Do Q".to_vec(),
    )));
    let page = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Page"));
        dict.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(200),
                Object::Integer(200),
            ]),
        );
        dict.set("Resources", Object::Reference(resources));
        dict.set("Contents", Object::Reference(body));
        dict
    }));
    let pages = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Pages"));
        dict.set("Kids", Object::Array(vec![Object::Reference(page)]));
        dict.set("Count", Object::Integer(1));
        dict
    }));
    let catalog = doc.add_object(Object::Dictionary({
        let mut dict = Dictionary::new();
        dict.set("Type", name("Catalog"));
        dict.set("Pages", Object::Reference(pages));
        dict
    }));
    doc.trailer.set("Root", Object::Reference(catalog));
    let input = dir.join("masked.pdf");
    doc.save(&input).unwrap();

    let output = dir.join("out.pdf");
    let report = call_compress_pdf(
        input.to_str().unwrap(),
        output.to_str().unwrap(),
        70,
        1_200,
    )
    .expect("即使无图可压，命令也应成功");
    assert_eq!(report.rewritten, 0);
    assert_eq!(report.skipped.len(), 1, "{:?}", report.skipped);
    assert!(report.skipped[0].contains("SMask"), "{:?}", report.skipped);
    assert!(report.skipped[0].contains("第 1 页"), "原因要能定位到页: {:?}", report.skipped);

    // 图不能转 JPEG，但它的采样仍可无损挤：底图 + 掩码两条流
    assert_eq!(report.flated, 2, "{:?}", report);
    let doc = Document::load(&output).unwrap();
    let ids = page_ids(&doc);
    assert_eq!(ids.len(), 1);
    let picture = inherited_image(&doc, ids[0]);
    assert_eq!(
        picture.dict.get(b"Filter").unwrap().as_name().unwrap(),
        b"FlateDecode",
        "转不了 JPEG 的图也该吃到无损压缩"
    );
    assert!(picture.dict.get(b"SMask").is_ok(), "/SMask 引用不能丢");
    let mut back = Vec::new();
    ZlibDecoder::new(&picture.content[..])
        .read_to_end(&mut back)
        .unwrap();
    assert_eq!(back, vec![3u8; 4_800], "无损压缩必须真的无损");
}
