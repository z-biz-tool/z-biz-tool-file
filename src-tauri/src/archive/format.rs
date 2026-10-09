//! 归档格式探测与能力表。
//!
//! 探测顺序是**魔数优先、扩展名兜底**：本机大量 `.zip` 其实是 docx/jar/apk 这类
//! ZIP 容器，也有把 `.tar.gz` 改名成 `.gz` 的下载残骸；只看扩展名会在这些地方
//! 给出错误的解压路径。反过来 brotli / 分卷没有可靠魔数，必须靠扩展名补。

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// 容器格式。Tar 的复合变体（tar.gz 等）单列，因为它们决定"先解外层再解内层"的顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    Zip,
    SevenZ,
    Rar,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
    TarZst,
    TarLz4,
    TarBr,
    /// 单流压缩：里面就是一个文件，不是归档
    Gz,
    Bz2,
    Xz,
    Zst,
    Lz4,
    Br,
    LzmaAlone,
    Cab,
    Iso,
    Wim,
    Ar,
    Rpm,
    Lzh,
    Z,
    Unknown,
}

impl Format {
    /// 稳定的机器可读 id，前端按这个字符串分支，不要改已有值
    pub fn id(self) -> &'static str {
        match self {
            Format::Zip => "zip",
            Format::SevenZ => "7z",
            Format::Rar => "rar",
            Format::Tar => "tar",
            Format::TarGz => "tar.gz",
            Format::TarBz2 => "tar.bz2",
            Format::TarXz => "tar.xz",
            Format::TarZst => "tar.zst",
            Format::TarLz4 => "tar.lz4",
            Format::TarBr => "tar.br",
            Format::Gz => "gz",
            Format::Bz2 => "bz2",
            Format::Xz => "xz",
            Format::Zst => "zst",
            Format::Lz4 => "lz4",
            Format::Br => "br",
            Format::LzmaAlone => "lzma",
            Format::Cab => "cab",
            Format::Iso => "iso",
            Format::Wim => "wim",
            Format::Ar => "ar",
            Format::Rpm => "rpm",
            Format::Lzh => "lzh",
            Format::Z => "z",
            Format::Unknown => "unknown",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Format::Zip => "ZIP",
            Format::SevenZ => "7-Zip",
            Format::Rar => "RAR",
            Format::Tar => "TAR",
            Format::TarGz => "TAR.GZ",
            Format::TarBz2 => "TAR.BZ2",
            Format::TarXz => "TAR.XZ",
            Format::TarZst => "TAR.ZST",
            Format::TarLz4 => "TAR.LZ4",
            Format::TarBr => "TAR.BR",
            Format::Gz => "GZIP",
            Format::Bz2 => "BZIP2",
            Format::Xz => "XZ",
            Format::Zst => "Zstandard",
            Format::Lz4 => "LZ4",
            Format::Br => "Brotli",
            Format::LzmaAlone => "LZMA",
            Format::Cab => "CAB",
            Format::Iso => "ISO 9660",
            Format::Wim => "WIM",
            Format::Ar => "AR",
            Format::Rpm => "RPM",
            Format::Lzh => "LZH",
            Format::Z => "compress",
            Format::Unknown => "未知",
        }
    }

    /// 该格式默认的写出扩展名（含点）。压缩对话框据此补全文件名。
    pub fn extension(self) -> &'static str {
        match self {
            Format::Zip => ".zip",
            Format::SevenZ => ".7z",
            Format::Tar => ".tar",
            Format::TarGz => ".tar.gz",
            Format::TarBz2 => ".tar.bz2",
            Format::TarXz => ".tar.xz",
            Format::TarZst => ".tar.zst",
            Format::TarLz4 => ".tar.lz4",
            Format::TarBr => ".tar.br",
            Format::Gz => ".gz",
            Format::Bz2 => ".bz2",
            Format::Xz => ".xz",
            Format::Zst => ".zst",
            Format::Lz4 => ".lz4",
            Format::Br => ".br",
            Format::LzmaAlone => ".lzma",
            _ => "",
        }
    }

    pub fn from_id(id: &str) -> Option<Format> {
        Some(match id.to_ascii_lowercase().as_str() {
            "zip" => Format::Zip,
            "7z" => Format::SevenZ,
            "tar" => Format::Tar,
            "tar.gz" | "tgz" => Format::TarGz,
            "tar.bz2" | "tbz2" => Format::TarBz2,
            "tar.xz" | "txz" => Format::TarXz,
            "tar.zst" | "tzst" => Format::TarZst,
            "tar.lz4" => Format::TarLz4,
            "tar.br" => Format::TarBr,
            "gz" | "gzip" => Format::Gz,
            "bz2" | "bzip2" => Format::Bz2,
            "xz" => Format::Xz,
            "zst" | "zstd" => Format::Zst,
            "lz4" => Format::Lz4,
            "br" | "brotli" => Format::Br,
            // `Format::LzmaAlone.id()` 就是 "lzma"；漏了这一条的话
            // `from_id(f.id()) == Some(f)` 对所有格式成立这句话就是假的，
            // 前端把选中的格式 id 回传时会得到 None，压缩按钮直接没反应。
            "lzma" => Format::LzmaAlone,
            _ => return None,
        })
    }

    pub fn caps(self) -> Caps {
        match self {
            Format::Zip => Caps {
                list: true,
                extract: true,
                create: true,
                test: true,
                add: true,
                encrypt_read: true,
                encrypt_write: true,
            },
            Format::SevenZ => Caps {
                list: true,
                extract: true,
                create: true,
                test: true,
                // 7z 是 solid 结构，"追加"等于整体重写；引擎内部就是这么做的，
                // 但对用户要如实标 false，免得他以为几百 MB 的包能秒加一个文件
                add: false,
                encrypt_read: true,
                encrypt_write: true,
            },
            Format::Rar => Caps {
                list: true,
                extract: true,
                create: false, // RAR 是专有格式，unrar 授权只允许解不允许压
                test: true,
                add: false,
                encrypt_read: true,
                encrypt_write: false,
            },
            Format::Tar => Caps {
                list: true,
                extract: true,
                create: true,
                test: true,
                add: true, // 纯 tar 可以直接 seek 到末尾追加
                encrypt_read: false,
                encrypt_write: false,
            },
            Format::TarGz | Format::TarBz2 | Format::TarXz | Format::TarZst | Format::TarLz4
            | Format::TarBr => Caps {
                list: true,
                extract: true,
                create: true,
                test: true,
                add: false, // 外层是流式压缩，追加要整体重写
                encrypt_read: false,
                encrypt_write: false,
            },
            Format::Gz | Format::Bz2 | Format::Xz | Format::Zst | Format::Lz4 | Format::Br
            | Format::LzmaAlone => Caps {
                list: true,
                extract: true,
                create: true,
                test: true,
                add: false,
                encrypt_read: false,
                encrypt_write: false,
            },
            Format::Cab => Caps {
                list: true,
                extract: true,
                create: false, // 7-Zip 自己也造不出 CAB，"替代 7-Zip"不要求这项
                // cab crate 在 load_block 里逐块验 CAB 自己的 checksum，
                // 所以"测试压缩包"是免费的：每个 folder 只解最后一个文件读到尾即可全覆盖
                test: true,
                add: false,
                encrypt_read: false,
                encrypt_write: false,
            },
            _ => Caps::none(),
        }
    }

    /// 能识别但不打算支持的格式，给用户一句人话，而不是笼统的"未知格式"
    pub fn unsupported_reason(self) -> Option<&'static str> {
        Some(match self {
            Format::Iso => "ISO 镜像建议直接用 Windows 资源管理器挂载（双击即可）",
            Format::Wim => "WIM 是 Windows 映像格式，需要 DISM 处理",
            Format::Ar => "AR/deb 包暂不支持",
            Format::Rpm => "RPM 包暂不支持",
            Format::Lzh => "LZH/LHA 是日系旧格式，暂不支持（可用 7-Zip 打开）",
            Format::Z => "Unix compress(.Z) 暂不支持",
            Format::Unknown => return None,
            _ => return None,
        })
    }
}

/// 某种格式支持哪些操作。前端据此渲染菜单，不做"灰掉一排按钮"的事——
/// 不支持的操作直接不渲染（见 [[feedback-ui-fewer-buttons]]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub list: bool,
    pub extract: bool,
    pub create: bool,
    pub test: bool,
    pub add: bool,
    pub encrypt_read: bool,
    pub encrypt_write: bool,
}

impl Caps {
    pub const fn none() -> Caps {
        Caps {
            list: false,
            extract: false,
            create: false,
            test: false,
            add: false,
            encrypt_read: false,
            encrypt_write: false,
        }
    }
}

/// 探测结果
#[derive(Debug, Clone)]
pub struct Detection {
    pub format: Format,
    /// 魔数命中还是只认了扩展名。扩展名命中时要提示用户"可能名不副实"
    pub by_magic: bool,
    /// 分卷：`.001` / `.partN.rar` / `.z01` 等
    pub volume_index: Option<u32>,
    /// ZIP 容器（docx/jar/apk…）：本质是 zip，但用户认知里它是文档
    pub container: Option<&'static str>,
}

const TAR_MAGIC_OFF: u64 = 257;
const ISO_MAGIC_OFF: u64 = 0x8001;

/// 读一个文件的前若干字节 + tar/iso 的固定偏移魔数
fn read_head(path: &Path) -> std::io::Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let mut f = File::open(path)?;
    let mut head = vec![0u8; 16];
    let n = f.read(&mut head)?;
    head.truncate(n);

    let mut tar_spot = Vec::new();
    if f.metadata().map(|m| m.len() > TAR_MAGIC_OFF + 5).unwrap_or(false) {
        if f.seek(SeekFrom::Start(TAR_MAGIC_OFF)).is_ok() {
            let mut b = [0u8; 5];
            if f.read_exact(&mut b).is_ok() {
                tar_spot = b.to_vec();
            }
        }
    }

    let mut iso_spot = Vec::new();
    if f.metadata().map(|m| m.len() > ISO_MAGIC_OFF + 5).unwrap_or(false) {
        if f.seek(SeekFrom::Start(ISO_MAGIC_OFF)).is_ok() {
            let mut b = [0u8; 5];
            if f.read_exact(&mut b).is_ok() {
                iso_spot = b.to_vec();
            }
        }
    }
    Ok((head, tar_spot, iso_spot))
}

/// 外层是流式压缩时，看解压后的前 512+ 字节里有没有 tar 的 "ustar"。
/// 只看扩展名会漏掉 `.tgz` 被改名成 `.gz` 的情况，而这两种走的是完全不同的代码路径
/// （单文件 gunzip vs tar 展开）。
fn inner_is_tar<R: Read>(mut r: R) -> bool {
    let mut buf = vec![0u8; 512 + 5];
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => break,
        }
    }
    buf.len() >= TAR_MAGIC_OFF as usize + 5 && &buf[257..262] == b"ustar"
}

/// 单流压缩里套的是不是 tar：解开外层，看第 257 字节起是不是 "ustar"。
///
/// `single` 是外层那个单流格式（Gz / Bz2 / Xz / Zst / Lz4 / Br），传别的当"认不出"处理。
/// 这里**不再另立一个 Codec 枚举**：`tar::Codec` 已经有一份一模一样的，两份枚举各写
/// 一遍 match，加一种算法时必然漏掉一边——那正是 tar.rs 模块头里说要避免的事。
fn inner_tar_check(path: &Path, single: Format) -> bool {
    let f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let r = BufReader::with_capacity(64 * 1024, f);
    match single {
        Format::Gz => inner_is_tar(flate2::read::GzDecoder::new(r)),
        Format::Bz2 => inner_is_tar(bzip2::read::BzDecoder::new(r)),
        Format::Xz => inner_is_tar(xz2::read::XzDecoder::new(r)),
        Format::Zst => match zstd::stream::read::Decoder::new(r) {
            Ok(d) => inner_is_tar(d),
            Err(_) => false,
        },
        Format::Lz4 => inner_is_tar(lz4_flex::frame::FrameDecoder::new(r)),
        Format::Br => inner_is_tar(brotli::Decompressor::new(r, 64 * 1024)),
        _ => false,
    }
}

/// ZIP 容器的扩展名 → 用户认知里的"它是什么"
fn zip_container(lower: &str) -> Option<&'static str> {
    let ext = lower.rsplit('.').next().unwrap_or("");
    Some(match ext {
        "docx" | "docm" => "Word 文档",
        "xlsx" | "xlsm" | "xlsb" => "Excel 表格",
        "pptx" | "ppsx" => "PowerPoint 演示",
        "odt" | "ods" | "odp" | "odg" => "OpenDocument",
        "epub" => "EPUB 电子书",
        "jar" => "Java JAR",
        "war" | "ear" => "Java 部署包",
        "apk" | "aab" => "Android 应用包",
        "xpi" => "浏览器扩展",
        "crx" => "Chrome 扩展",
        "vsix" => "VS Code 扩展",
        "nupkg" => "NuGet 包",
        "whl" => "Python wheel",
        "cbz" => "漫画包",
        "sketch" => "Sketch 设计稿",
        "zipx" => "ZIPX",
        _ => return None,
    })
}

/// 分卷命名：`.001/.002…`、`.partN.rar`、`.z01/.zip`
fn volume_index_of(lower: &str) -> Option<u32> {
    if let Some(idx) = lower.rfind('.') {
        let tail = &lower[idx + 1..];
        if tail.len() == 3 && tail.chars().all(|c| c.is_ascii_digit()) {
            return tail.parse().ok();
        }
        if tail.len() == 2 && tail.starts_with('z') && tail[1..].chars().all(|c| c.is_ascii_digit()) {
            return tail[1..].parse().ok();
        }
        if tail == "rar" {
            // foo.part3.rar → 3；foo.rar → 1
            if let Some(p) = lower.rfind(".part") {
                let between = &lower[p + 5..idx];
                if let Ok(n) = between.parse::<u32>() {
                    return Some(n);
                }
            }
            return Some(1);
        }
        // foo.rar 之后的旧式分卷叫 foo.r00 / foo.r01…，所以 r00 是第 2 卷。
        // 尾巴是 **3** 个字符（r + 两位数字），不是 2 个——写成 2 的话 `.r00` 一个都认不出来。
        if tail.len() == 3 && tail.starts_with('r') && tail[1..].chars().all(|c| c.is_ascii_digit())
        {
            return Some(tail[1..].parse::<u32>().map(|n| n + 2).unwrap_or(2));
        }
    }
    None
}

/// 纯扩展名判断（没有魔数可读、或文件太小时用）
fn format_from_ext(lower: &str) -> Format {
    // 双扩展名要先于单扩展名匹配，否则 `x.tar.gz` 会被判成 gz
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Format::TarGz;
    }
    if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") || lower.ends_with(".tbz") {
        return Format::TarBz2;
    }
    if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        return Format::TarXz;
    }
    if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
        return Format::TarZst;
    }
    if lower.ends_with(".tar.lz4") {
        return Format::TarLz4;
    }
    if lower.ends_with(".tar.br") {
        return Format::TarBr;
    }
    if lower.ends_with(".tar") {
        return Format::Tar;
    }
    // 分卷：先看主格式，`.001` 本身不带格式信息
    // `.z01` / `.z02`… 是 WinZip 式的 zip 分卷，卷名里没有 zip 字样，必须单独认
    if zip_split_volume(lower) {
        return Format::Zip;
    }
    let base = strip_volume_suffix(lower);
    if base.ends_with(".rar") || base.ends_with(".cbr") {
        return Format::Rar;
    }
    if base.ends_with(".7z") {
        return Format::SevenZ;
    }
    if base.ends_with(".zip") || base.ends_with(".zipx") || zip_container(&base).is_some() {
        return Format::Zip;
    }
    // 没有 '.' 时 `rsplit('.').next()` 会返回**整个文件名**，于是一个叫 `a` 的文件
    // 会被当成 ar 包、一个叫 `z` 的会被当成 Z 包。必须显式取"最后一个点之后的部分"。
    let ext = match base.rfind('.') {
        Some(i) => &base[i + 1..],
        None => "",
    };
    match ext {
        "gz" => Format::Gz,
        "bz2" => Format::Bz2,
        "xz" => Format::Xz,
        "zst" => Format::Zst,
        "lz4" => Format::Lz4,
        "br" => Format::Br,
        "lzma" => Format::LzmaAlone,
        "cab" => Format::Cab,
        "iso" => Format::Iso,
        "wim" | "swm" | "esd" => Format::Wim,
        "rpm" => Format::Rpm,
        "deb" | "a" | "ar" => Format::Ar,
        "lzh" | "lha" => Format::Lzh,
        "z" => Format::Z,
        // `.001` 这类裸分卷：无法从名字判断内层，交给魔数
        "001" | "002" | "003" => Format::Unknown,
        _ => Format::Unknown,
    }
}

fn strip_volume_suffix(lower: &str) -> String {
    if let Some(idx) = lower.rfind('.') {
        let tail = &lower[idx + 1..];
        let is_num = !tail.is_empty()
            && tail.len() <= 3
            && tail.chars().all(|c| c.is_ascii_digit());
        if is_num || zip_split_volume(lower) {
            return lower[..idx].to_string();
        }
        // .partN.rar 保留 .rar
    }
    lower.to_string()
}

/// `.z01` / `.z02` … / `.z99`：WinZip 式 zip 分卷的后续卷（第一卷仍叫 `.zip`）。
///
/// 必须显式排除 `.zip` / `.zst` / `.z`：它们同样以 z 开头，但后面不是纯数字。
fn zip_split_volume(lower: &str) -> bool {
    match lower.rfind('.') {
        Some(idx) => {
            let tail = &lower[idx + 1..];
            tail.len() >= 2 && tail.starts_with('z') && tail[1..].chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// 主探测入口
pub fn detect(path: &Path) -> Detection {
    let lower = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let volume_index = volume_index_of(&lower);
    let container = zip_container(&strip_volume_suffix(&lower));
    let ext_guess = format_from_ext(&lower);

    let (head, tar_spot, iso_spot) = match read_head(path) {
        Ok(v) => v,
        // 读不了就只剩扩展名可用
        Err(_) => {
            return Detection {
                format: ext_guess,
                by_magic: false,
                volume_index,
                container,
            }
        }
    };

    let magic = |sig: &[u8]| head.len() >= sig.len() && &head[..sig.len()] == sig;

    let format = if magic(b"PK\x03\x04") || magic(b"PK\x05\x06") || magic(b"PK\x07\x08") {
        Format::Zip
    } else if magic(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        Format::SevenZ
    } else if magic(b"Rar!\x1a\x07") {
        Format::Rar
    } else if magic(&[0x1F, 0x8B]) {
        if inner_tar_check(path, Format::Gz) { Format::TarGz } else { Format::Gz }
    } else if magic(b"BZh") {
        if inner_tar_check(path, Format::Bz2) { Format::TarBz2 } else { Format::Bz2 }
    } else if magic(&[0xFD, b'7', b'z', b'X', b'Z', 0x00]) {
        if inner_tar_check(path, Format::Xz) { Format::TarXz } else { Format::Xz }
    } else if magic(&[0x28, 0xB5, 0x2F, 0xFD]) {
        if inner_tar_check(path, Format::Zst) { Format::TarZst } else { Format::Zst }
    } else if magic(&[0x04, 0x22, 0x4D, 0x18]) {
        if inner_tar_check(path, Format::Lz4) { Format::TarLz4 } else { Format::Lz4 }
    } else if magic(b"MSCF") {
        Format::Cab
    } else if magic(&[b'M', b'S', b'W', b'I', b'M', 0, 0, 0]) {
        Format::Wim
    } else if magic(b"!<arch>") {
        Format::Ar
    } else if magic(&[0xED, 0xAB, 0xEE, 0xDB]) {
        Format::Rpm
    } else if tar_spot == b"ustar" {
        Format::Tar
    } else if iso_spot == b"CD001" {
        Format::Iso
    } else if head.len() >= 3 && head[0] == 0x5D && head[1] == 0 && head[2] == 0 {
        // LZMA alone 的魔数很弱（属性字节 + 字典大小），单独出现时只在扩展名也说
        // 是 lzma 的情况下才认，避免把随机二进制误判
        if ext_guess == Format::LzmaAlone { Format::LzmaAlone } else { Format::Unknown }
    } else {
        Format::Unknown
    };

    let by_magic = format != Format::Unknown;
    // 魔数认不出（brotli 无魔数、空文件、分卷的 `.001`）时退回扩展名
    let format = if by_magic { format } else { ext_guess };

    Detection {
        format,
        by_magic,
        volume_index,
        container,
    }
}

/// 压缩算法。同一格式下不同算法的等级上限差别很大（deflate 到 9、zstd 到 22、store 无意义），
/// 所以等级上限挂在方法上，不是挂在格式上。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodOption {
    pub id: String,
    pub label: String,
    pub description: String,
    pub max_level: u32,
    pub default_level: u32,
}

/// 前端"新建压缩"对话框用的可写格式清单（含说明）。写死在 Rust 侧是为了让
/// 能力表和实现永远是同一份，不会前端列了个后端根本不会写的格式。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatOption {
    pub id: String,
    pub label: String,
    pub extension: String,
    pub description: String,
    pub max_level: u32,
    pub default_level: u32,
    pub supports_password: bool,
    pub supports_solid: bool,
    /// 分卷。ZIP 的 spanning 需要写多文件流，zip crate 不支持；7z 支持
    pub supports_volumes: bool,
    /// 归档注释。zip / rar 支持，7z / tar 不支持
    pub supports_comment: bool,
    /// 可选压缩算法，第一项是默认
    pub methods: Vec<MethodOption>,
}

fn m(id: &str, label: &str, description: &str, max_level: u32, default_level: u32) -> MethodOption {
    MethodOption {
        id: id.into(),
        label: label.into(),
        description: description.into(),
        max_level,
        default_level,
    }
}

/// 只有外层压缩的格式（tar.xx / 单文件 xx）：算法由格式本身决定，没得选。
fn no_methods() -> Vec<MethodOption> {
    Vec::new()
}

pub fn writable_formats() -> Vec<FormatOption> {
    use Format::*;
    vec![
        FormatOption { id: SevenZ.id().into(), label: "7-Zip (.7z)".into(), extension: ".7z".into(),
            description: "压缩率最高，LZMA2 算法，支持 AES-256 加密".into(),
            max_level: 9, default_level: 5, supports_password: true, supports_solid: true,
            // 引擎写不出分卷（输出是单个 Write+Seek，7z 的分卷还要求后续卷复制签名头），
            // 所以这里如实给 false，前端就不渲染分卷那一栏——比渲染出来再报错好
            supports_volumes: false, supports_comment: false,
            methods: vec![
                m("lzma2", "LZMA2", "默认，压缩率与速度平衡最好", 9, 5),
                m("copy", "Copy（不压缩）", "只打包，速度最快", 0, 0),
            ] },
        FormatOption { id: Zip.id().into(), label: "ZIP (.zip)".into(), extension: ".zip".into(),
            description: "兼容性最好，Windows/macOS 原生可解".into(),
            max_level: 9, default_level: 6, supports_password: true, supports_solid: false,
            supports_volumes: false, supports_comment: true,
            methods: vec![
                m("deflate", "Deflate", "标准 ZIP 算法，兼容性最好", 9, 6),
                m("store", "Store（不压缩）", "已压缩过的文件（视频/图片/安装包）用这个，白跑一遍压缩毫无收益", 0, 0),
                m("zstd", "Zstd", "比 Deflate 小 10-20%，但只有本 App 和 7-Zip 能解", 22, 9),
                m("bzip2", "BZip2", "老式，压缩率一般", 9, 9),
                m("xz", "XZ", "压缩率高但慢，Windows 自带的解压不了", 9, 6),
            ] },
        FormatOption { id: TarGz.id().into(), label: "TAR.GZ (.tar.gz)".into(), extension: ".tar.gz".into(),
            description: "Linux 发行包标准格式".into(),
            max_level: 9, default_level: 6, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: TarXz.id().into(), label: "TAR.XZ (.tar.xz)".into(), extension: ".tar.xz".into(),
            description: "比 gzip 压得更小，更慢".into(),
            max_level: 9, default_level: 6, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: TarZst.id().into(), label: "TAR.ZST (.tar.zst)".into(), extension: ".tar.zst".into(),
            description: "多线程压缩，速度与压缩率平衡最好".into(),
            max_level: 22, default_level: 3, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: TarBz2.id().into(), label: "TAR.BZ2 (.tar.bz2)".into(), extension: ".tar.bz2".into(),
            description: "老式 bzip2，兼容性考虑".into(),
            max_level: 9, default_level: 9, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: TarLz4.id().into(), label: "TAR.LZ4 (.tar.lz4)".into(), extension: ".tar.lz4".into(),
            description: "极快，压缩率换速度".into(),
            max_level: 12, default_level: 1, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: TarBr.id().into(), label: "TAR.BR (.tar.br)".into(), extension: ".tar.br".into(),
            description: "Brotli，Web 分发常用".into(),
            max_level: 11, default_level: 6, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: Tar.id().into(), label: "TAR (.tar)".into(), extension: ".tar".into(),
            description: "只打包不压缩".into(),
            max_level: 0, default_level: 0, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: Gz.id().into(), label: "GZIP (.gz)".into(), extension: ".gz".into(),
            description: "单文件 gzip".into(),
            max_level: 9, default_level: 6, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: Zst.id().into(), label: "Zstandard (.zst)".into(), extension: ".zst".into(),
            description: "单文件 zstd".into(),
            max_level: 22, default_level: 3, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: Bz2.id().into(), label: "BZIP2 (.bz2)".into(), extension: ".bz2".into(),
            description: "单文件 bzip2".into(),
            max_level: 9, default_level: 9, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: Xz.id().into(), label: "XZ (.xz)".into(), extension: ".xz".into(),
            description: "单文件 xz".into(),
            max_level: 9, default_level: 6, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: Lz4.id().into(), label: "LZ4 (.lz4)".into(), extension: ".lz4".into(),
            description: "单文件 lz4，极快".into(),
            max_level: 12, default_level: 1, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        FormatOption { id: Br.id().into(), label: "Brotli (.br)".into(), extension: ".br".into(),
            description: "单文件 brotli".into(),
            max_level: 11, default_level: 6, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
        // `.lzma` 是 LZMA1 裸流（没有 xz 的头尾），7-Zip 能造，Linux 的 `lzma` 命令也认。
        // 留在这里是为了"从 7-Zip 迁过来的老脚本还能用"，压缩率不如 7z/xz，所以排在最后。
        FormatOption { id: LzmaAlone.id().into(), label: "LZMA (.lzma)".into(), extension: ".lzma".into(),
            description: "单文件 LZMA1 裸流（旧格式，兼容 7-Zip 的 .lzma）".into(),
            max_level: 9, default_level: 6, supports_password: false, supports_solid: false,
            supports_volumes: false, supports_comment: false, methods: no_methods() },
    ]
}

/// 文件对话框过滤器用的扩展名全集（含只读格式）
pub fn all_extensions() -> Vec<&'static str> {
    vec![
        "zip", "zipx", "7z", "rar", "cbr", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz",
        "zst", "tzst", "lz4", "br", "lzma", "cab", "iso", "wim", "jar", "war", "apk", "epub",
        "docx", "xlsx", "pptx", "odt", "ods", "odp", "xpi", "crx", "vsix", "nupkg", "whl",
        "cbz", "001",
    ]
}

/// 给定一个"解压到 <这个名字>"的默认目录名：剥掉所有已知归档扩展名。
/// 原来这段逻辑在前端 App.tsx 里手写了一串 if，加格式就要两边改；
/// 现在由后端算，前端直接用。
pub fn stem_for_extract(path: &Path) -> String {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("archive");
    let mut lower = name.to_ascii_lowercase();
    let mut out = name.to_string();
    // 反复剥：`x.tar.gz` → `x.tar` → `x`；`x.zip.001` → `x.zip` → `x`
    loop {
        let before = lower.clone();
        // `>=` 而不是 `>`：文件名整个就是一个后缀（`.gz`）时要剥成空串，
        // 再由末尾那句退化成 "archive"；用 `>` 会把 ".gz" 原样返回，
        // 前端拿它去建目录就会得到一个名叫 ".gz" 的隐藏文件夹。
        let strip = |s: &str, suf: &str| -> Option<String> {
            if s.ends_with(suf) && s.len() >= suf.len() {
                Some(s[..s.len() - suf.len()].to_string())
            } else {
                None
            }
        };
        for suf in [
            ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tbz", ".tar.xz", ".txz", ".tar.zst",
            ".tzst", ".tar.lz4", ".tar.br", ".tar", ".zip", ".zipx", ".7z", ".rar", ".cbr",
            ".gz", ".bz2", ".xz", ".zst", ".lz4", ".br", ".lzma", ".cab", ".iso", ".lzh",
            ".lha", ".wim", ".rpm", ".deb", ".z",
        ] {
            if let Some(v) = strip(&lower, suf) {
                lower = v;
                out = out[..lower.len()].to_string();
                break;
            }
        }
        // 分卷后缀
        if let Some(idx) = lower.rfind('.') {
            let tail = &lower[idx + 1..];
            let is_num = !tail.is_empty() && tail.len() <= 3 && tail.chars().all(|c| c.is_ascii_digit());
            let is_z = tail.len() >= 2 && tail.starts_with('z') && tail[1..].chars().all(|c| c.is_ascii_digit());
            if is_num || is_z {
                lower = lower[..idx].to_string();
                out = out[..lower.len()].to_string();
                continue;
            }
        }
        // `.partN.rar` / `.partN.zip`：上面的后缀表已经把 `.rar` 剥掉了，
        // 这里接着剥 `.partN`。不能只看"名字里有没有 .part"——`my.partition.tar`
        // 会被误伤，所以要求 `.part` 后面全是数字。
        if let Some(p) = lower.rfind(".part") {
            let after = &lower[p + 5..];
            if !after.is_empty() && after.chars().all(|c| c.is_ascii_digit()) {
                lower = lower[..p].to_string();
                out = out[..lower.len()].to_string();
                continue;
            }
        }
        if lower == before {
            break;
        }
    }
    if out.is_empty() { "archive".to_string() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_strips_compound_and_volume_suffixes() {
        assert_eq!(stem_for_extract(Path::new("/x/a.tar.gz")), "a");
        assert_eq!(stem_for_extract(Path::new("/x/a.tgz")), "a");
        assert_eq!(stem_for_extract(Path::new("/x/a.tar.bz2")), "a");
        assert_eq!(stem_for_extract(Path::new("/x/a.7z")), "a");
        assert_eq!(stem_for_extract(Path::new("/x/a.zip.001")), "a");
        assert_eq!(stem_for_extract(Path::new("/x/movie.part3.rar")), "movie");
        assert_eq!(stem_for_extract(Path::new("/x/a.tar")), "a");
        assert_eq!(stem_for_extract(Path::new("/x/.gz")), "archive");
    }

    #[test]
    fn ext_detection_prefers_compound_suffix() {
        assert_eq!(format_from_ext("a.tar.gz"), Format::TarGz);
        assert_eq!(format_from_ext("a.tar"), Format::Tar);
        assert_eq!(format_from_ext("a.docx"), Format::Zip);
        assert_eq!(format_from_ext("a.part2.rar"), Format::Rar);
        assert_eq!(format_from_ext("a.z01"), Format::Zip);
        assert_eq!(format_from_ext("a.unknownext"), Format::Unknown);
        // 没有扩展名的文件不能靠"最后一个点之后的部分"取到整个文件名，
        // 否则一个叫 `a` 的文件会被当成 ar 包、叫 `z` 的会被当成 Z 包
        assert_eq!(format_from_ext("a"), Format::Unknown);
        assert_eq!(format_from_ext("z"), Format::Unknown);
        assert_eq!(format_from_ext("libfoo.a"), Format::Ar);
    }

    #[test]
    fn volume_index_parsing() {
        assert_eq!(volume_index_of("a.zip.003"), Some(3));
        assert_eq!(volume_index_of("a.part7.rar"), Some(7));
        assert_eq!(volume_index_of("a.rar"), Some(1));
        assert_eq!(volume_index_of("a.r00"), Some(2));
        assert_eq!(volume_index_of("a.zip"), None);
    }

    #[test]
    fn caps_are_honest_about_rar() {
        assert!(!Format::Rar.caps().create);
        assert!(Format::Rar.caps().extract);
        assert!(Format::SevenZ.caps().encrypt_write);
        assert_eq!(Format::Iso.caps(), Caps::none());
    }

    /// 前端把选中的格式 id 原样回传，后端再 `from_id` 还原。这条链一断，
    /// 压缩对话框里选什么都不生效——而它断掉的方式是静默的（`None` 被当成"未知格式"）。
    /// `.lzma` 就曾经漏在这里。
    #[test]
    fn every_writable_format_survives_an_id_round_trip() {
        for opt in writable_formats() {
            let f = Format::from_id(&opt.id)
                .unwrap_or_else(|| panic!("from_id({:?}) 返回 None", opt.id));
            assert_eq!(f.id(), opt.id, "id 往返不一致");
            assert!(f.caps().create, "{} 在可写列表里却 create=false", opt.id);
            assert_eq!(
                f.extension(),
                opt.extension,
                "{} 的扩展名和 Format::extension() 对不上",
                opt.id
            );
        }
    }
}
