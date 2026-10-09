//! 真实世界归档的差分回归：本引擎 vs 7-Zip。
//!
//! 单元测试里的压缩包全是测试自己现造的 —— 造的人和解的人是同一份代码，于是
//! "格式边角到底认不认"这件事永远测不到。RAR5 的 8638 个条目、712 层目录、
//! Windows 属性位、`v6:m3:32M` 这种方法串，只有真实文件里才有。
//!
//! 文件里有两类测试。**差分那几条**要真实样本，拿不到就 `note_skip` 返回（不算失败，
//! 但会在 `--nocapture` 下留一句话 —— 静默跳过和"通过"在报告里同形，那是最容易
//! 骗过自己的结果）。**往返那几条**不需要任何外部文件，每次 `cargo test` 都跑。
//! 要跑差分就给环境变量：
//!
//! ```text
//! ZBT_REAL_ARCHIVE    真实归档的路径
//! ZBT_REAL_7ZLISTING  `7z l -slt -ba -sccUTF-8 "<归档>" > 这个文件` 的输出；给了才做逐条目差分
//! ZBT_REAL_ARCHIVE_OUT 解压验证的落点（要和大包同一块盘，别默认落 C:）；给了才解。
//!                      同一个变量还决定"每种格式写一个样本"落在哪（见文件末尾）
//! ZBT_7Z_EXE          7z.exe 的路径；给了才做"7-Zip 亲自读我们写的东西"那一步
//! ```
//!
//! 生成基准（7-Zip 只用来当"另一个独立实现"，不参与被测代码路径）。
//! `-sccUTF-8` **不能省**：7-Zip 默认按控制台代码页写，简中系统上中文包名会变成 GBK，
//! 那份文件根本不是合法 UTF-8。
//!
//! ```text
//! "C:\Program Files\7-Zip\7z.exe" l -slt -ba -sccUTF-8 "D:\temp\x.rar" > D:\temp\x.7z.txt
//! ```
//!
//! ## 为什么不干脆把基准数字写死在断言里
//!
//! 写死的话，换一个包就得改测试，于是没人会去跑第二个包 —— 而"只在一个包上对过"
//! 恰恰是这类验证最脆弱的地方。解析 7-Zip 的输出多花三十行，换来的是任何包都能当基准。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use z_biz_tool_file_lib::test_bridge as tb;

/// 7-Zip `-slt` 的一个条目块。只留用得到的字段。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Sz {
    path: String,
    is_dir: bool,
    size: u64,
    packed: u64,
    /// 7-Zip 对目录不给 CRC，字段是空的
    crc: Option<u32>,
}

fn fixture() -> Option<PathBuf> {
    std::env::var_os("ZBT_REAL_ARCHIVE")
        .map(PathBuf::from)
        .filter(|p| Path::new(p).is_file())
}

fn listing() -> Option<PathBuf> {
    std::env::var_os("ZBT_REAL_7ZLISTING")
        .map(PathBuf::from)
        .filter(|p| Path::new(p).is_file())
}

fn out_root() -> Option<PathBuf> {
    std::env::var_os("ZBT_REAL_ARCHIVE_OUT")
        .map(PathBuf::from)
        .filter(|p| p.as_os_str().len() > 0)
}

/// 跳过时留一句话。
///
/// 静默 `return` 的测试在报告里和"通过"完全同形，而这个文件里有四条取决于
/// 本机有没有那个包 —— 全跳过还全绿，是最容易骗过自己的那种结果。
/// 不用 panic 表达"跳过"：本机没放 fixture 不是失败，红了就没人再跑这个文件了。
fn note_skip(what: &str) {
    eprintln!("[跳过] 缺 {}（跑法见本文件头部注释）", what);
}

/// 读基准文件。两个坑，都踩过：
///
/// - 7-Zip 默认按**控制台代码页**写输出。简中系统上是 GBK，中文包名于是不是合法 UTF-8，
///   `read_to_string` 直接报 "stream did not contain valid UTF-8"。生成基准要加 `-sccUTF-8`。
/// - 加了 `-sccUTF-8` 之后某些版本会在开头写一个 BOM，`lines()` 会把它算进第一个键名。
///
/// 这里**不能**退化成 lossy 解码：中文名被换成 U+FFFD 之后就和引擎给出的真名对不上了，
/// 测试会报一堆根本不存在的差异 —— 那比直接报错更难查。
fn read_baseline(p: &Path) -> String {
    let bytes = std::fs::read(p)
        .unwrap_or_else(|e| panic!("读不了基准文件 {}: {}", p.display(), e));
    let body: &[u8] = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes
    };
    match std::str::from_utf8(body) {
        Ok(s) => s.to_string(),
        Err(e) => panic!(
            "基准文件不是 UTF-8（偏移 {}）。7-Zip 默认按控制台代码页输出，             重新生成时加上 -sccUTF-8：
  7z l -slt -ba -sccUTF-8 \"<归档>\" > <基准>",
            e.valid_up_to()
        ),
    }
}

/// 解析 `7z l -slt -ba` 的输出。
///
/// 按**第一个** `" = "` 切，因为条目名里可以带等号（`a=b.txt`），
/// 而键名里不会有空格。`\` 一律换成 `/`，和引擎出口的写法对齐。
fn parse_slt(text: &str) -> Vec<Sz> {
    fn flush(cur: &mut BTreeMap<String, String>, out: &mut Vec<Sz>) {
        let Some(path) = cur.remove("Path") else {
            cur.clear();
            return;
        };
        let num = |k: &str| -> u64 {
            cur.get(k).and_then(|v| v.trim().parse().ok()).unwrap_or(0)
        };
        // CRC 一律按**十六进制**读：7-Zip 打的就是十六进制（`8A8483B1`），
        // 而先试十进制会让 `12345678` 这种"看起来像十进制"的 CRC 静默解析成另一个数，
        // 于是差分报告出一条根本不存在的 CRC 不一致
        let crc = cur
            .get("CRC")
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .and_then(|v| u32::from_str_radix(v, 16).ok());
        out.push(Sz {
            // 7-Zip 用系统分隔符，Windows 上是 '\'；引擎出口统一是 '/'
            path: path.replace('\\', "/"),
            is_dir: folder_flag(cur),
            size: num("Size"),
            packed: num("Packed Size"),
            crc,
        });
        cur.clear();
    }

    let mut out = Vec::new();
    let mut cur: BTreeMap<String, String> = BTreeMap::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        if let Some((k, v)) = line.split_once(" = ") {
            cur.insert(k.trim().to_string(), v.to_string());
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// 从 `-slt` 的一个条目块里判"是不是目录"。
///
/// `Folder` 键**不是每种归档都有**。实测 7-Zip 26.03 对我们写的 `.7z`：
/// `7z l` 的表格明明白白是 `D....` + "5 files, 3 folders"，而 `7z l -slt` 里
/// 那三条目录**压根没有 Folder 这一行**。zip / rar / tar 都给，7z 不给。
///
/// 缺键时退到 `Block`：7z 的每个**文件**条目都归属某个压缩块（`Block = 0`），
/// 目录不属于任何块，于是那一行在，但值是空的（`Block = `）。
/// 不能只判"有没有 Block 这个键"—— gzip 这类单流容器列出来的那个内层文件
/// 也没有 Block 键，而它是个文件。
fn folder_flag(cur: &BTreeMap<String, String>) -> bool {
    match cur.get("Folder") {
        Some(v) => v == "+",
        None => cur.get("Block").map(|v| v.trim().is_empty()).unwrap_or(false),
    }
}

/// 引擎的条目表按 path 建索引。同名条目（zip 允许）在这里会互相覆盖，
/// 但差分本来就按 path 比对，重名的那一侧同样是塌成一个键，两边一致。
fn index_ours(entries: &[tb::Entry]) -> BTreeMap<String, &tb::Entry> {
    entries.iter().map(|e| (e.path.clone(), e)).collect()
}

fn index_theirs(v: &[Sz]) -> BTreeMap<String, &Sz> {
    v.iter().map(|s| (s.path.clone(), s)).collect()
}

/// 引擎的条目表 vs 7-Zip 的条目表 → 差异清单（空 = 一致）。
///
/// 文件里有两处差分：一处对**基准文件**（真实大包），一处对**现场跑的 7z**
/// （我们自己写的样本）。两处必须用同一套规则 —— 各自写一遍比法的话，
/// 改了这边忘了那边，同一个 bug 会在一处红一处绿，而人只会去查红的那处。
///
/// 规则：
/// - 路径集合必须完全相同（少了、多了都算差异）
/// - 目录标志必须相同
/// - **目录的 size 不比**：引擎给的是子树合计（`rollup_dir_sizes`），7-Zip 给 0，
///   两种口径，比了只会得到一屏假差异
/// - CRC 只在 7-Zip 给了的时候比：tar 家族不存 CRC，那个字段是空的
/// - `packed` 不比：单条目的压缩后大小恰恰是各格式报法最不一致的一项
///   （solid 共享字典、tar 压根没有），比出来的多半是噪声；总量另有断言
fn diff_entries(
    ours: &BTreeMap<String, &tb::Entry>,
    theirs: &BTreeMap<String, &Sz>,
) -> Vec<String> {
    let mut out = Vec::new();
    for k in theirs.keys().filter(|k| !ours.contains_key(*k)) {
        out.push(format!("引擎少列了 {}", k));
    }
    for k in ours.keys().filter(|k| !theirs.contains_key(*k)) {
        out.push(format!("引擎多列了 {}", k));
    }
    for (k, t) in theirs {
        let Some(o) = ours.get(k) else { continue };
        if o.is_dir != t.is_dir {
            out.push(format!("{}: 目录标志 引擎={} 7-Zip={}", k, o.is_dir, t.is_dir));
        }
        if t.is_dir {
            continue;
        }
        if o.size != t.size {
            out.push(format!("{}: 大小 引擎={} 7-Zip={}", k, o.size, t.size));
        }
        if let Some(tc) = t.crc {
            if o.crc != tc {
                out.push(format!("{}: CRC 引擎={:08X} 7-Zip={:08X}", k, o.crc, tc));
            }
        }
    }
    out
}

/// 差分的报告要能一眼看出"少了什么、多了什么、哪几条对不上"，
/// 所以先把三类各自截断到 10 条再拼字符串：8638 个条目全打出来等于没打。
fn diff_report<T: std::fmt::Debug>(label: &str, items: &[T]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let head: Vec<String> = items.iter().take(10).map(|x| format!("{:?}", x)).collect();
    format!(
        "\n{} {} 处（前 {} 条）: {}",
        label,
        items.len(),
        head.len(),
        head.join(" | ")
    )
}

#[test]
fn probe_recognizes_the_real_archive() {
    let Some(src) = fixture() else {
        note_skip("ZBT_REAL_ARCHIVE");
        return;
    };
    let p = tb::call_archive_probe(src.to_str().unwrap());
    assert!(p.is_archive, "真实归档必须被认出来: {:?}", src);
    assert!(p.caps.extract, "认出来了却说不能解压，前端会连菜单都不渲染");
    assert!(
        !p.is_secondary_volume,
        "单独一个完整归档不该被判成分卷的后续卷"
    );
    if p.format == "rar" {
        // UnRAR 许可证禁止创建 RAR。这条要是哪天变成 true，说明有人把写 RAR 接进来了，
        // 那是法律风险不是功能增加
        assert!(!p.caps.create, "RAR 只能是只读");
    }
}

#[test]
fn info_is_self_consistent() {
    let Some(src) = fixture() else {
        note_skip("ZBT_REAL_ARCHIVE");
        return;
    };
    let info = tb::call_archive_info(src.to_str().unwrap()).expect("能列出真实归档");
    assert!(!info.truncated, "条目被截断了，后面的差分没有意义");
    assert_eq!(
        info.entry_count,
        info.entries.len(),
        "entry_count 和 entries 长度必须一致，前端两个地方都在用"
    );
    // total_size 只累加文件：目录的 size 是子树合计（rollup_dir_sizes），加进来就是重复计算
    let file_sum: u64 = info.entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
    assert_eq!(info.total_size, file_sum, "total_size 不该含目录的汇总值");
    assert!(
        info.entries.iter().any(|e| e.is_dir) || info.entry_count == 1,
        "真实的安装包几乎一定有目录；一个都没有通常说明目录条目被丢了"
    );
    // 每个文件条目都该有名字，且名字是路径的最后一段
    for e in info.entries.iter().filter(|e| !e.is_dir) {
        assert!(!e.name.is_empty(), "条目没有名字: {}", e.path);
        assert!(
            e.path.ends_with(&e.name),
            "name 应该是 path 的最后一段: {} / {}",
            e.path,
            e.name
        );
    }
}

#[test]
fn listing_matches_7zip_entry_by_entry() {
    let (Some(src), Some(base)) = (fixture(), listing()) else {
        note_skip("ZBT_REAL_ARCHIVE / ZBT_REAL_7ZLISTING");
        return;
    };
    let text = read_baseline(&base);
    let theirs = parse_slt(&text);
    assert!(!theirs.is_empty(), "基准文件解析出 0 个条目，格式对不上");

    let info = tb::call_archive_info(src.to_str().unwrap()).expect("能列出真实归档");
    let ours = index_ours(&info.entries);
    let their = index_theirs(&theirs);

    // 大小 / CRC / 是否目录 / 路径集合：规则和现场跑 7z 的那处差分共用一份，见 diff_entries
    let diff = diff_entries(&ours, &their);
    assert!(
        diff.is_empty(),
        "与 7-Zip 的列表对不上（引擎 {} 条 / 7-Zip {} 条）{}",
        info.entry_count,
        theirs.len(),
        diff_report("差异", &diff)
    );

    // 总量：这两个数是前端标题栏直接显示的，错了用户一眼就能看出来
    let their_size: u64 = theirs.iter().filter(|s| !s.is_dir).map(|s| s.size).sum();
    let their_packed: u64 = theirs.iter().filter(|s| !s.is_dir).map(|s| s.packed).sum();
    assert_eq!(info.total_size, their_size, "未压缩总量对不上");
    // 压缩后总量只有两种可接受的答案：和 7-Zip 一致，或者如实是 0（这个格式没报）。
    // 第三种就是 bug —— RAR 后端原先写的是 `packed = unpacked_size`，在这个 8638 条目的
    // 真实包上于是 `total_packed == total_size`，界面算出"压缩率 100%"，
    // 而 7-Zip 打开同一个包是 7.38 GB / 9.46 GiB ≈ 78%。
    // 一个看着像样的错数字比 0 糟得多：0 前端认得出来，会显示"此格式不提供"。
    assert!(
        info.total_packed == their_packed || info.total_packed == 0,
        "压缩后总量既不是 7-Zip 的 {} 也不是 0（0 表示格式没报），而是 {}",
        their_packed,
        info.total_packed
    );
}

/// 抽样解压 + 逐字节 CRC 校验。
///
/// 抽样而不是全解：真实安装包里最大的单文件几百 MB，全解一遍是十分钟级 + 十几 GB 落盘，
/// 不适合当回归跑。抽法刻意不随机 —— 首个、末个、最大、以及**跨 solid 块边界**的那几条，
/// 这几处正是"列表对得上但解出来是坏的"最容易发生的位置。
#[test]
fn extracts_a_sample_and_matches_crc() {
    let (Some(src), Some(base), Some(root)) = (fixture(), listing(), out_root()) else {
        note_skip("ZBT_REAL_ARCHIVE / ZBT_REAL_7ZLISTING / ZBT_REAL_ARCHIVE_OUT");
        return;
    };
    let text = read_baseline(&base);
    let theirs = parse_slt(&text);
    let files: Vec<&Sz> = theirs.iter().filter(|s| !s.is_dir).collect();
    assert!(files.len() >= 4, "样本太少，这个 fixture 不适合做解压验证");

    let biggest = files.iter().max_by_key(|s| s.size).unwrap();
    // 用 map 去重而不是 dedup：dedup 只消掉**相邻**的重复，而这几条恰好分散在
    // 首/中/尾/最大四个位置，小包里它们很可能是同一个条目
    let mut picked: BTreeMap<String, &Sz> = BTreeMap::new();
    for s in [files[0], files[files.len() / 2], files[files.len() - 1], *biggest] {
        picked.insert(s.path.clone(), s);
    }
    let names: Vec<String> = picked.keys().cloned().collect();

    let dest = root.join(format!("zbt-real-extract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    let stats = tb::call_archive_extract_entries(src.to_str().unwrap(), dest.to_str().unwrap(), &names)
        .unwrap_or_else(|e| panic!("抽样解压失败: {}", e));
    assert!(
        stats.errors.is_empty(),
        "keep_broken 收下了 {} 条单条目错误: {:?}",
        stats.errors.len(),
        &stats.errors[..stats.errors.len().min(5)]
    );

    for s in picked.values() {
        // 归档里可能只有一个顶层目录，也可能没有；两种落点都试一下再判失败，
        // 否则这个测试会因为"剥不剥根"这种与正确性无关的选择而红
        let direct = dest.join(s.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let landed = if direct.is_file() {
            direct
        } else {
            let stripped = s.path.splitn(2, '/').nth(1).unwrap_or_else(|| s.path.as_str());
            let alt = dest.join(stripped.replace('/', std::path::MAIN_SEPARATOR_STR));
            assert!(alt.is_file(), "解出来的文件不在预期位置: {}", s.path);
            alt
        };
        let bytes = std::fs::read(&landed).expect("能读回解出的文件");
        assert_eq!(
            bytes.len() as u64,
            s.size,
            "解出来的长度和 7-Zip 记的不一样: {}",
            s.path
        );
        let got = crc32(&bytes);
        let want = s.crc.unwrap_or_else(|| panic!("基准里没有 {} 的 CRC", s.path));
        assert_eq!(
            got, want,
            "内容对不上（CRC {:08X} vs 7-Zip 的 {:08X}）: {}",
            got, want, s.path
        );
    }

    let _ = std::fs::remove_dir_all(&dest);
}

/// 长路径：解压落点 + 条目名合起来超过 Windows 的 MAX_PATH（260）。
///
/// 这条不需要 fixture，随时能跑，而它恰恰是"能不能替掉 7-Zip"的一个硬指标：
/// 7-Zip 走长路径感知的 API，用户把安装包解到一个本来就挺深的目录里不会失败；
/// 我们这边 `path_guard` 中间夹了一次 `canonicalize`，`\\?\` 前缀会不会在某一步被吃掉，
/// 光看代码判断不了（Rust std 在 Windows 上确实会自动加前缀，但那是"理论上"）。
///
/// 失败的样子很恶心：不是报错，是**解到一半**在某个深条目上崩，用户得到一个
/// 缺了东西的目录，而进度条已经走完了。
#[test]
fn extracts_past_windows_max_path() {
    if cfg!(not(windows)) {
        // Linux/macOS 的 PATH_MAX 是 4096，同样长度根本不构成场景
        eprintln!("[跳过] 长路径这条只在 Windows 上有意义");
        return;
    }

    let ws = tb::TempDir::new("longpath");
    // 8 段 × 25 字符 = 200，加上临时目录本身那 ~85 字符，落点已经越过 260
    let mut deep = ws.join("root");
    for i in 0..8 {
        deep = deep.join(format!("segment_{:02}_padding_", i));
    }
    std::fs::create_dir_all(&deep).unwrap_or_else(|e| panic!("建不出深目录 {}: {}", deep.display(), e));

    let entry_name = "deep_file_with_a_fairly_long_name_used_for_testing.txt";
    let payload = b"long path payload".repeat(64);
    let zip = ws.join("deep.zip");
    {
        // 用 zip crate 直接造，不走我们自己的写入端：不然失败时分不清是写坏了还是解不开
        let f = std::fs::File::create(&zip).unwrap();
        let mut w = zip::ZipWriter::new(f);
        w.start_file(entry_name, zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut w, &payload).unwrap();
        w.finish().unwrap();
    }

    let landed = deep.join(entry_name);
    let full = landed.to_string_lossy().len();
    assert!(
        full > 260,
        "这个用例的前提没了：落点全长 {} 没超过 MAX_PATH，测了等于没测",
        full
    );

    tb::call_archive_extract(zip.to_str().unwrap(), deep.to_str().unwrap())
        .unwrap_or_else(|e| panic!("超过 MAX_PATH 的落点解压失败（全长 {}）: {}", full, e));

    let got = std::fs::read(&landed)
        .unwrap_or_else(|e| panic!("解出来了但读不回来 {}: {}", landed.display(), e));
    assert_eq!(got, payload, "内容对不上");
}

/// CRC-32 (IEEE)，和 zip / rar 里存的是同一个多项式。
///
/// 自己写 30 行而不是引一个 crate：这是**验证**代码，用被测项目自己的依赖去校验
/// 被测项目的输出，等于让考生自己改卷子。
fn crc32(bytes: &[u8]) -> u32 {
    const fn table() -> [u32; 256] {
        let mut t = [0u32; 256];
        let mut i = 0;
        while i < 256 {
            let mut c = i as u32;
            let mut k = 0;
            while k < 8 {
                c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
                k += 1;
            }
            t[i] = c;
            i += 1;
        }
        t
    }
    let t = table();
    let mut crc = 0xFFFF_FFFFu32;
    for b in bytes {
        crc = t[((crc ^ *b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

#[test]
fn crc32_helper_matches_known_values() {
    // 校验器自己得先被校验：这两个是 CRC-32/IEEE 的标准测试向量
    assert_eq!(crc32(b"123456789"), 0xCBF43926);
    assert_eq!(crc32(b""), 0x00000000);
}

#[test]
fn slt_parser_handles_the_awkward_cases() {
    let text = "Path = a\\b = c.txt\r\nFolder = -\r\nSize = 12\r\nPacked Size = 7\r\nCRC = 8A8483B1\r\n\r\nPath = d\\\r\nFolder = +\r\nSize = 0\r\nCRC = \r\n\r\n";
    let v = parse_slt(text);
    assert_eq!(v.len(), 2, "两个块");
    // 名字里带等号：只按第一个 " = " 切，否则 "b = c.txt" 会被当成键
    assert_eq!(v[0].path, "a/b = c.txt");
    assert_eq!(v[0].size, 12);
    assert_eq!(v[0].packed, 7);
    assert_eq!(v[0].crc, Some(0x8A84_83B1));
    assert!(!v[0].is_dir);
    assert_eq!(v[1].path, "d/");
    assert!(v[1].is_dir);
    // 目录没有 CRC，空字符串不能解析成 0 —— 0 是"内容真的是空/全零"的合法值
    assert_eq!(v[1].crc, None);
}

/// `Folder` 键缺失时的四种真实形状。全是 7-Zip 26.03 在本机实测抄下来的，
/// 不是想象的：判错一种，差分就会报出成百上千条根本不存在的"目录标志不一致"。
#[test]
fn slt_parser_classifies_dirs_without_the_folder_key() {
    let text = "\
Path = corpus\r\nSize = 0\r\nPacked Size = 0\r\nCRC = \r\nMethod = \r\nBlock = \r\n\r\n\
Path = corpus\\empty.dat\r\nSize = 0\r\nPacked Size = 1\r\nCRC = 00000000\r\nMethod = LZMA2:23\r\nBlock = 0\r\n\r\n\
Path = round_trip.tar\r\nSize = 10752\r\nPacked Size = 4563\r\nHost OS = 255\r\nCRC = D48F960C\r\n\r\n\
Path = d\r\nFolder = +\r\nSize = 0\r\n\r\n";
    let v = parse_slt(text);
    assert_eq!(v.len(), 4);
    // 7z 的目录：没有 Folder，Block 在但值是空的
    assert!(v[0].is_dir, "7z 的目录条目该判成目录（Block 空）");
    // 7z 的 0 字节文件：Size 也是 0，但 Block 有块号 —— 不能和目录混
    assert!(!v[1].is_dir, "7z 的 0 字节文件该判成文件（Block = 0）");
    assert_eq!(v[1].crc, Some(0));
    // 单流容器列出来的那个内层文件：既没有 Folder 也没有 Block，它是文件
    assert!(!v[2].is_dir, "gzip 里的内层 tar 该判成文件（无 Block 键）");
    // 老老实实给了 Folder 的（zip / rar / tar）
    assert!(v[3].is_dir);
}

// ============================================================================
// 反方向：我们写出来的包，别人要能读
// ============================================================================
//
// "替掉 7-Zip"这句话有两半。上面那几条验的是前一半：用户手里已有的包要能解。
// 后一半是用户新压的包要能被别的工具打开 —— 少了它，做出来的就是一个只有
// 自己读得懂的东西，而那比没有这个功能更糟：它看起来能用，坏在数据出口。
//
// 这里**不去 spawn 7z.exe**。测试一旦依赖"本机装了 7-Zip"，那台没装的机器上
// 它就只能跳过或者报错，而 7-Zip 恰恰是被替换掉的那个，不该反过来当被测的前提。
// 所以这一段验的是引擎自洽（写完能认、能校验、能解、字节全等），
// 交叉验证交给 `writes_samples_for_external_verification`：它只负责把每个格式
// 丢一个样本到磁盘上，拿 `7z l` / `7z t` 去验的那一步在仓库外的命令行里做。

/// 语料。故意全是些会让路径拼接、编码和空条目出问题的东西 —— 规规矩矩的
/// `a.txt` 压完解回来当然是对的，那种语料验不出任何事。
fn build_corpus(root: &Path) {
    let put = |p: &Path, b: &[u8]| {
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).unwrap_or_else(|e| panic!("建不出 {}: {}", d.display(), e));
        }
        std::fs::write(p, b).unwrap_or_else(|e| panic!("写不出 {}: {}", p.display(), e));
    };

    // 中文名 + 空格。Windows 上文件名以 UTF-16 存盘，而 ZIP 的老规范只认 CP437，
    // 写读两端编码不一致就变成一堆问号 —— 这是归档工具最经典的翻车点。
    put(&root.join("中文名 文件.txt"), "内容 body\r\n第二行".as_bytes());
    // & 和括号：命令行转义和 shell 引号问题的常客，也是某些实现拼名字时会截断的字符
    put(&root.join("with spaces & (parens).bin"), &binary_blob());
    put(&root.join("深层").join("再深一层").join("leaf.md"), b"# leaf");
    // 0 字节：有的写入端干脆不生成条目，解回来就成了"文件丢了"
    put(&root.join("empty.dat"), b"");
    // 名字里带两层扩展名，且长得像一个归档。探测要是按扩展名而不是按魔数，
    // 解压这一支就会把它当成 tar.gz 去解
    put(&root.join("looks.like.an.archive.tar.gz"), b"not really an archive");
}

/// 确定性的"二进制"内容。
///
/// 不能全用可打印字符：那样即使某一环做了 lossy 的 UTF-8 解码，
/// 只要没撞上非法字节序列就照样对得上，测试等于没看。
/// 0x00、0xFF 和跨 UTF-8 边界的字节才是最容易被悄悄改掉的。
fn binary_blob() -> Vec<u8> {
    let mut v = Vec::with_capacity(4096);
    let mut s: u32 = 0x1234_5678;
    for _ in 0..4096 {
        s = s.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        v.push((s >> 16) as u8);
    }
    v
}

/// 递归收集 `root` 下的所有文件：相对路径（一律 `/`）→ 字节。
fn walk_files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = std::fs::read_dir(&d)
            .unwrap_or_else(|e| panic!("读不了目录 {}: {}", d.display(), e));
        for ent in rd {
            let p = ent.unwrap_or_else(|e| panic!("读目录项失败: {}", e)).path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                let bytes = std::fs::read(&p)
                    .unwrap_or_else(|e| panic!("读不了 {}: {}", p.display(), e));
                out.insert(rel, bytes);
            }
        }
    }
    out
}

/// 两棵树的差异，写成人话。
///
/// 直接 `assert_eq!` 两个 `BTreeMap<String, Vec<u8>>` 的话，失败输出会把
/// 几千字节二进制原样打出来，真正的那条线索反倒被埋在里面。
fn tree_diff(want: &BTreeMap<String, Vec<u8>>, got: &BTreeMap<String, Vec<u8>>) -> String {
    let names = |v: Vec<&String>| -> String {
        v.iter().take(10).map(|x| x.as_str()).collect::<Vec<_>>().join(", ")
    };
    let missing: Vec<&String> = want.keys().filter(|k| !got.contains_key(*k)).collect();
    let extra: Vec<&String> = got.keys().filter(|k| !want.contains_key(*k)).collect();
    let differ: Vec<&String> = want
        .iter()
        .filter(|(k, v)| got.get(*k).map(|g| g != *v).unwrap_or(false))
        .map(|(k, _)| k)
        .collect();

    let mut s = String::from("解回来的树和语料对不上");
    if !missing.is_empty() {
        s.push_str(&format!("\n  少了 {} 个: {}", missing.len(), names(missing)));
    }
    if !extra.is_empty() {
        s.push_str(&format!("\n  多了 {} 个: {}", extra.len(), names(extra)));
    }
    if !differ.is_empty() {
        s.push_str(&format!("\n  内容不一致 {} 个: {}", differ.len(), names(differ.clone())));
        for k in differ.iter().take(3) {
            let (w, g) = (&want[*k], &got[*k]);
            s.push_str(&format!(
                "\n    {}: 应 {} B (crc {:08X})，实 {} B (crc {:08X})",
                k,
                w.len(),
                crc32(w),
                g.len(),
                crc32(g)
            ));
        }
    }
    s
}

/// 语料的期望树：`corpus/` 前缀下的每个文件 → 字节。
///
/// 目录源存进归档时带顶层文件夹名（`corpus/x.txt`），和 7-Zip 右键"添加到压缩包"一致，
/// 所以不管是我们解还是 7-Zip 解，落点都是 `<out>/corpus/...`。
fn expected_tree(ws: &Path) -> BTreeMap<String, Vec<u8>> {
    walk_files(ws)
        .into_iter()
        .filter(|(k, _)| k.starts_with("corpus/"))
        .collect()
}

/// 容器格式的验收：整棵树逐字节比。
fn verify_tree(out: &Path, want: &BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    let got = walk_files(out);
    if got != *want {
        return Err(tree_diff(want, &got));
    }
    Ok(())
}

/// 单流格式的验收。解出来的文件名由后端定（一般是剥掉压缩扩展名），
/// 我们和 7-Zip 的剥法还未必一样，所以不猜名字，只认"恰好一个文件、字节全等"。
fn verify_single_stream(out: &Path, payload: &[u8]) -> Result<(), String> {
    let got = walk_files(out);
    let hits = got.values().filter(|b| b.as_slice() == payload).count();
    if hits != 1 {
        return Err(format!(
            "单流解回来该恰好一个与源字节全等的文件，实际 {} 个（共 {} 个: {}）",
            hits,
            got.len(),
            got.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    Ok(())
}

/// 一种格式的完整往返：写 → 认出来 → 校验 → 解回来 → 字节全等。
fn round_trip_one(opt: &tb::FormatOption) -> Result<(), String> {
    let single = tb::is_single_stream_format(opt);
    let ws = tb::TempDir::new("roundtrip");
    let corpus = ws.join("corpus");
    std::fs::create_dir_all(&corpus).map_err(|e| format!("建语料目录: {}", e))?;
    build_corpus(&corpus);

    const PAYLOAD: &str = "中文名 文件.txt";
    let payload = std::fs::read(corpus.join(PAYLOAD)).map_err(|e| e.to_string())?;

    // 单流格式天生只装一个文件，喂它目录只会拿到一句"只能压单个文件"。
    // 容器格式才值得跑整棵语料树 —— 嵌套、空条目这些只有在容器里才存在。
    let sources: Vec<String> = if single {
        vec![corpus.join(PAYLOAD).to_string_lossy().to_string()]
    } else {
        vec![corpus.to_string_lossy().to_string()]
    };

    let dest = ws.join(format!("round_trip{}", opt.extension));
    let opts = tb::CreateOptions { format: opt.id.clone(), ..Default::default() };
    let stats = tb::call_archive_create_with(&sources, dest.to_str().unwrap(), &opts)
        .map_err(|e| format!("写不出来: {}", e))?;

    if !dest.is_file() {
        return Err(format!("说写完了，{} 却不存在", dest.display()));
    }
    if stats.bytes_done == 0 {
        return Err("Stats.bytes_done 是 0 —— 前端进度条会从头到尾不动".into());
    }

    let probe = tb::call_archive_probe(dest.to_str().unwrap());
    if !probe.is_archive {
        return Err("刚写出来的文件，探测说它不是归档".into());
    }
    let info = tb::call_archive_info(dest.to_str().unwrap()).map_err(|e| format!("info: {}", e))?;

    let out = ws.join("out");
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    tb::call_archive_extract(dest.to_str().unwrap(), out.to_str().unwrap())
        .map_err(|e| format!("解不回来: {}", e))?;

    if single {
        verify_single_stream(&out, &payload)?;
    } else {
        let want = expected_tree(&ws);
        // 空对空是相等的，所以这条验收必须有这个前提。哪天 build_corpus 被改空了，
        // 往返测试会照常全绿 —— 而报告上看不出它其实什么都没验
        assert!(
            want.len() >= 4,
            "语料只有 {} 个文件，这条测试的前提没了",
            want.len()
        );
        verify_tree(&out, &want)?;
        // 条目数单独比一次：树相等已经隐含了，但这条挂在 info 上，
        // 比的是"界面列表里会显示几行"，和"磁盘上落了几个文件"是两件事
        let files = info.entries.iter().filter(|e| !e.is_dir).count();
        if files != want.len() {
            return Err(format!("info 报了 {} 个文件条目，语料里有 {} 个", files, want.len()));
        }
    }
    Ok(())
}

#[test]
fn writable_formats_split_into_containers_and_single_streams() {
    // 上一条测试按这个判据分派语料，所以判据自己得先被测：
    // 哪天 `is_single_stream_format` 全返 false，往返测试会照常全绿 ——
    // 只是单流那一半根本没跑到，而报告上看不出来。
    let f = tb::call_archive_writable_formats();
    assert!(!f.is_empty(), "一个可写格式都没有，那前端那个下拉框是空的");
    let (single, container): (Vec<_>, Vec<_>) =
        f.iter().partition(|o| tb::is_single_stream_format(o));
    assert!(!single.is_empty(), "没有单流格式？gz/xz/zst 至少该在");
    assert!(!container.is_empty(), "没有容器格式？zip/7z/tar 至少该在");
    for id in ["zip", "7z", "tar"] {
        assert!(container.iter().any(|o| o.id == id), "{} 被当成单流格式了", id);
    }
    for id in ["gz", "xz", "zst"] {
        assert!(single.iter().any(|o| o.id == id), "{} 被当成容器格式了", id);
    }
}

#[test]
fn every_writable_format_round_trips() {
    let formats = tb::call_archive_writable_formats();

    // 攒齐所有失败再一次报出来，不在循环里 assert：16 种格式逐个炸要重跑 16 次编译，
    // 而这些失败彼此独立。一次全看到，才能立刻分辨是"某一个格式坏了"
    // 还是"公共路径坏了"——后者的表现是几乎所有格式一起红。
    let mut failures = Vec::new();
    for opt in &formats {
        if let Err(e) = round_trip_one(opt) {
            failures.push(format!("[{} {}] {}", opt.id, opt.extension, e));
        }
    }
    assert!(
        failures.is_empty(),
        "{} 种可写格式里 {} 种没能往返:\n{}",
        formats.len(),
        failures.len(),
        failures.join("\n\n")
    );
}

/// 把每种可写格式各写一个样本到 `ZBT_REAL_ARCHIVE_OUT/roundtrip-samples/`，
/// 供仓库外用真正的 7-Zip 交叉验证：
///
/// ```text
/// for %f in (D:\temp\samples\*) do @("C:\Program Files\7-Zip\7z.exe" t "%f" || echo 坏了: %f)
/// "C:\Program Files\7-Zip\7z.exe" l -slt -ba -sccUTF-8 D:\temp\samples\round_trip.7z
/// ```
///
/// 分成两条测试（自己验自己 / 交出去给别人验）是因为前者每次 `cargo test` 都该跑，
/// 后者只在人想核对的时候跑 —— 混在一条里，日常那次就会白写十几个包。
#[test]
fn writes_samples_for_external_verification() {
    let Some(root) = out_root() else {
        note_skip("ZBT_REAL_ARCHIVE_OUT");
        return;
    };
    let dir = root.join("roundtrip-samples");
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .unwrap_or_else(|e| panic!("清不掉旧样本 {}: {}", dir.display(), e));
    }
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("建不出 {}: {}", dir.display(), e));

    // 语料放在样本目录**外面**：放进去会被下面的循环当成"要压的源"之外的杂物，
    // 也会让 `7z l` 的输出里混进无关条目
    let ws = tb::TempDir::new("samples");
    let corpus = ws.join("corpus");
    std::fs::create_dir_all(&corpus).unwrap();
    build_corpus(&corpus);
    let one = corpus.join("中文名 文件.txt");

    let mut wrote = Vec::new();
    let mut failures = Vec::new();
    for opt in tb::call_archive_writable_formats() {
        let sources: Vec<String> = if tb::is_single_stream_format(&opt) {
            vec![one.to_string_lossy().to_string()]
        } else {
            vec![corpus.to_string_lossy().to_string()]
        };
        let dest = dir.join(format!("round_trip{}", opt.extension));
        let opts = tb::CreateOptions { format: opt.id.clone(), ..Default::default() };
        match tb::call_archive_create_with(&sources, dest.to_str().unwrap(), &opts) {
            Ok(_) => wrote.push(dest.to_string_lossy().to_string()),
            Err(e) => failures.push(format!("[{}]: {}", opt.id, e)),
        }
    }
    eprintln!("样本 {} 个已写到 {}", wrote.len(), dir.display());
    for p in &wrote {
        eprintln!("  {}", p);
    }
    assert!(
        failures.is_empty(),
        "这些格式连样本都没写出来:\n{}",
        failures.join("\n")
    );
}

// ============================================================================
// 交叉验证：让 7-Zip 亲自读一遍我们写的东西
// ============================================================================
//
// `every_writable_format_round_trips` 证明的是引擎**自洽** —— 但写读两端是同一份
// 代码，一个只有我们自己认得的怪格式也能自洽地往返。真正的判据是让另一个独立实现
// 读一遍。这条测试就是那个判据，也是"替掉 7-Zip"这句话能立住的最后一步。
//
// opt-in：给 `ZBT_7Z_EXE` 才跑。默认 `cargo test` 不该依赖"本机装了 7-Zip"，
// 尤其因为这个项目的目标恰恰是把它替换掉 —— 让被替换者变成测试通过的前提，
// 等它真被卸掉那天，测试就全跳过了，而报告上看不出来。

fn sz_exe() -> Option<PathBuf> {
    std::env::var_os("ZBT_7Z_EXE")
        .map(PathBuf::from)
        .filter(|p| Path::new(p).is_file())
}

/// 7-Zip 26.03 **没有解码器**的格式。实测 `7z i` 的 Formats 表里有
/// 7z / zip / tar / gzip / bzip2 / xz / zstd / lzma / lzma86 / Rar / Cab，
/// 没有 lz4，也没有 brotli —— 所以这四个不是我们写坏了，是对面读不了。
///
/// 写死一张表就是第二份真相，于是下面那条测试断言它是"我们能写的格式"的子集：
/// 哪天 lz4 从写入端撤了或者改名了，这里会立刻红，而不是悄悄少验一种。
/// 要验这四个得换官方 CLI（`lz4 -t` / `brotli -t`），不在这个文件的职责里。
const NO_SZ_DECODER: &[&str] = &["lz4", "br", "tar.lz4", "tar.br"];

fn run_7z(sz: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new(sz)
        .args(args)
        .output()
        .map_err(|e| format!("跑不动 {}: {}", sz.display(), e))
}

fn sz_diag(o: &std::process::Output) -> String {
    format!(
        "退出码 {:?}\n{}\n{}",
        o.status.code(),
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
}

/// 报错只留末尾一段：7z 的输出开头几十行是版权横幅和命令行回显，真正的错在最后。
fn tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    // 从字符边界起截：中文名被从中间劈开，`&s[i..]` 会直接 panic
    let start = s.len() - n;
    let start = (start..s.len()).find(|i| s.is_char_boundary(*i)).unwrap_or(0);
    format!("…{}", &s[start..])
}

/// 目录里该恰好一个文件，返回它。
fn only_file(dir: &Path) -> Result<PathBuf, String> {
    let f = walk_files(dir);
    match f.keys().next() {
        Some(k) if f.len() == 1 => Ok(dir.join(k)),
        _ => Err(format!(
            "该恰好一个文件，实际 {} 个: {}",
            f.len(),
            f.keys().cloned().collect::<Vec<_>>().join(", ")
        )),
    }
}

/// 一种格式的全套交叉验证：`7z t`（完整性）→ `7z x`（解出来字节全等）
/// → `7z l -slt`（容器格式再比一遍元数据）。
fn cross_check_one(sz: &Path, opt: &tb::FormatOption) -> Result<(), String> {
    let single = tb::is_single_stream_format(opt);
    let ws = tb::TempDir::new("xcheck");
    let corpus = ws.join("corpus");
    std::fs::create_dir_all(&corpus).map_err(|e| format!("建语料目录: {}", e))?;
    build_corpus(&corpus);

    const PAYLOAD: &str = "中文名 文件.txt";
    let payload = std::fs::read(corpus.join(PAYLOAD)).map_err(|e| e.to_string())?;
    let sources: Vec<String> = if single {
        vec![corpus.join(PAYLOAD).to_string_lossy().to_string()]
    } else {
        vec![corpus.to_string_lossy().to_string()]
    };

    let dest = ws.join(format!("x{}", opt.extension));
    let d = dest.to_str().unwrap();
    tb::call_archive_create_with(
        &sources,
        d,
        &tb::CreateOptions { format: opt.id.clone(), ..Default::default() },
    )
    .map_err(|e| format!("写不出来: {}", e))?;

    let o = run_7z(sz, &["t", d])?;
    if !o.status.success() {
        return Err(format!("7z t 判它坏了: {}", tail(&sz_diag(&o), 900)));
    }

    let out = ws.join("out7z");
    let o = run_7z(sz, &["x", "-y", &format!("-o{}", out.display()), d])?;
    if !o.status.success() {
        return Err(format!("7z x 失败: {}", tail(&sz_diag(&o), 900)));
    }

    // `7z x` 对 tar.gz / tar.xz / tar.zst / tar.bz2 **只剥外层**，落地的是中间那个 .tar，
    // 不是内容。这不是我们写坏了：拿 7-Zip 自己造的 .tar.gz 跑同一条命令，行为一模一样
    // （GUI 会自动开第二层，CLI 不会）。所以这里手动再开一层。
    // 元数据差分也要跟着挪到内层：对 .tar.gz 跑 `7z l -slt`，7-Zip 报的是
    // "里面有一个 10752 字节的 tar"，一条 —— 和语料那五条对不上是应该的。
    let (landed, meta_target) = if opt.id.starts_with("tar.") {
        let inner = only_file(&out).map_err(|e| format!("剥外层之后: {}", e))?;
        let out2 = ws.join("out7z2");
        let o = run_7z(sz, &["x", "-y", &format!("-o{}", out2.display()), inner.to_str().unwrap()])?;
        if !o.status.success() {
            return Err(format!("7z x 内层 tar 失败: {}", tail(&sz_diag(&o), 900)));
        }
        (out2, inner)
    } else {
        (out.clone(), dest.clone())
    };

    if single {
        verify_single_stream(&landed, &payload).map_err(|e| format!("7-Zip 解出来的: {}", e))?;
    } else {
        verify_tree(&landed, &expected_tree(&ws)).map_err(|e| format!("7-Zip 解出来的: {}", e))?;
    }

    // 元数据差分只做容器格式。单流不做：`7z l` 报的是 gzip 头里存的**内层文件名**，
    // 和"剥掉压缩扩展名"是两套命名规则，比名字只会比出噪声，而字节已经比过了。
    if !single {
        let o = run_7z(sz, &["l", "-slt", "-ba", "-sccUTF-8", meta_target.to_str().unwrap()])?;
        if !o.status.success() {
            return Err(format!("7z l 失败: {}", tail(&sz_diag(&o), 900)));
        }
        // 这里必须严格解码，和 read_baseline 同理：中文名变成 U+FFFD 之后
        // 就和引擎给的真名对不上，差分报告会全是根本不存在的差异
        let text = std::str::from_utf8(&o.stdout)
            .map_err(|e| {
                format!(
                    "加了 -sccUTF-8 输出仍不是 UTF-8（偏移 {}）—— 7-Zip 版本可能不认这个开关",
                    e.valid_up_to()
                )
            })?
            .trim_start_matches('\u{feff}')
            .to_string();
        let theirs = parse_slt(&text);
        if theirs.is_empty() {
            return Err("7z l -slt 解析出 0 个条目，格式对不上".into());
        }
        // 比的是内层，所以引擎这边也要看内层：外层那个 .tar.gz 在引擎眼里同样只有
        // "一个 10752 字节的 tar"，两边都停在同一层才对得上
        let info = tb::call_archive_info(meta_target.to_str().unwrap())
            .map_err(|e| format!("info: {}", e))?;
        let diff = diff_entries(&index_ours(&info.entries), &index_theirs(&theirs));
        if !diff.is_empty() {
            return Err(format!(
                "和 7-Zip 的列表有 {} 处不一致:\n  {}",
                diff.len(),
                diff.iter().take(12).cloned().collect::<Vec<_>>().join("\n  ")
            ));
        }
    }
    Ok(())
}

#[test]
fn external_7zip_reads_what_we_write() {
    let Some(sz) = sz_exe() else {
        note_skip("ZBT_7Z_EXE");
        return;
    };
    let formats = tb::call_archive_writable_formats();
    let ids: Vec<&str> = formats.iter().map(|o| o.id.as_str()).collect();
    for stale in NO_SZ_DECODER.iter().filter(|f| !ids.contains(f)) {
        panic!(
            "{} 已经不在可写格式清单里了，NO_SZ_DECODER 这张表过期了 —— 改名字还是撤了，得说清楚",
            stale
        );
    }

    let mut failures = Vec::new();
    let mut no_decoder = Vec::new();
    let mut checked = 0;
    for opt in &formats {
        if NO_SZ_DECODER.contains(&opt.id.as_str()) {
            no_decoder.push(opt.id.clone());
            continue;
        }
        checked += 1;
        if let Err(e) = cross_check_one(&sz, opt) {
            failures.push(format!("[{} {}] {}", opt.id, opt.extension, e));
        }
    }

    // 跳过的要留话。静默少验四种格式，报告上和"全都验过了"同形
    eprintln!(
        "[交叉验证] 7-Zip 认可了 {} 种格式；这 {} 种它没有解码器，验不了: {}",
        checked,
        no_decoder.len(),
        no_decoder.join(", ")
    );
    assert!(checked > 0, "一种都没验上，那 NO_SZ_DECODER 是不是把清单吃干净了");
    assert!(
        failures.is_empty(),
        "7-Zip 读不了我们写的这些:\n{}",
        failures.join("\n\n")
    );
}
