//! 归档引擎的公共数据类型。前端 `ArchiveExplorer.tsx` 里的 TS interface 与此一一对应，
//! 改字段要两边一起改。

use serde::{Deserialize, Serialize};

/// 归档内一个条目
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// 在归档内的序号，稳定标识（路径可能重复，zip 允许同名条目）
    pub index: u32,
    /// 归档内路径，统一用 '/' 分隔
    pub path: String,
    /// 最后一段名字，表格直接显示这个
    pub name: String,
    pub is_dir: bool,
    /// 未压缩大小；目录为递归汇总值
    pub size: u64,
    /// 压缩后大小；solid 归档（7z/rar）里单个条目的这个值没有意义，为 0
    pub packed: u64,
    /// Unix 秒；0 = 该格式不存时间
    pub modified: i64,
    /// 压缩方法名，"Deflate" / "LZMA2" / "Store" …
    pub method: String,
    pub encrypted: bool,
    pub crc: u32,
    pub comment: String,
    /// 符号链接的目标；解压时按普通文件落地（见 guard.rs 的攻击说明）
    pub symlink_target: String,
}

/// 整个归档的元信息 + 条目表
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub path: String,
    pub format: String,
    pub format_label: String,
    /// ZIP 容器的真身，例如 docx / apk；不是容器时为 None
    pub container: Option<String>,
    pub entry_count: usize,
    pub total_size: u64,
    pub total_packed: u64,
    /// 有任意条目加密
    pub needs_password: bool,
    /// 连目录结构都加密（7z 的 -mhe，rar 的加密文件名）。此时不给密码连列表都拿不到
    pub encrypted_headers: bool,
    pub solid: bool,
    pub multipart: bool,
    pub volumes: Vec<String>,
    pub comment: String,
    pub caps: super::format::Caps,
    /// 条目数超过上限时截断，前端要提示用户"列表不完整"
    pub truncated: bool,
    pub entries: Vec<Entry>,
}

/// 解压选项
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtractOptions {
    /// 只解这些条目（归档内路径）。None/空 = 全解
    pub entries: Option<Vec<String>>,
    pub password: Option<String>,
    pub overwrite: super::guard::Overwrite,
    /// 单条目失败时继续，最后汇总报告。默认 false（一处错就整体失败，和 7-Zip 一致）
    pub keep_broken: bool,
    /// 归档只有一个顶层目录时把它剥掉（7-Zip 的"解压到当前文件夹"常配合这个用）
    pub strip_root: bool,
    /// 忽略目录结构，全部平铺到 dest
    pub flatten: bool,
    /// 只解出这些条目所在的部分，用于"解压选中项的子树"
    pub include_children: bool,
}

/// 压缩选项
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateOptions {
    pub format: String,
    /// 压缩等级；None = 该格式默认
    pub level: Option<i32>,
    /// 压缩算法名，取值随格式而变。zip: store/deflate/bzip2/zstd/xz；7z: lzma2/ppmd/bzip2
    /// None = 该格式默认（zip 是 deflate，7z 是 lzma2）
    pub method: Option<String>,
    pub password: Option<String>,
    /// 加密文件名（仅 7z）
    pub encrypt_header: bool,
    /// solid 压缩（仅 7z）：压得更小，但单文件抽取变慢
    pub solid: bool,
    pub comment: Option<String>,
    /// 分卷大小（字节），0/None = 不分卷
    pub volume_size: Option<u64>,
    /// 存进去的路径怎么算相对：以每个源的父目录为基准（默认，等价 7-Zip 的"添加到压缩包"）
    pub store_full_path: bool,
    pub exclude_patterns: Vec<String>,
}

impl Default for CreateOptions {
    fn default() -> Self {
        CreateOptions {
            format: "zip".to_string(),
            level: None,
            method: None,
            password: None,
            encrypt_header: false,
            solid: false,
            comment: None,
            volume_size: None,
            store_full_path: false,
            exclude_patterns: Vec::new(),
        }
    }
}

/// 归档级别的附加信息。不同格式能拿到的东西差别很大（tar 没有加密也没有分卷），
/// 拿不到就留默认值，前端按 `Caps` 决定渲不渲染。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMeta {
    /// solid 压缩：条目之间共享字典。好处是压得更小，代价是**抽取单个文件也要
    /// 从头解到那一条**，UI 上要说清楚，否则用户会以为卡死了。
    pub solid: bool,
    /// 连文件名都加密了（7z 的 -mhe、rar 的"加密文件名"）。不给密码连列表都拿不到。
    pub encrypted_headers: bool,
    pub multipart: bool,
    /// 分卷文件路径列表（含不存在的那些，前端据此提示缺第几卷）
    pub volumes: Vec<String>,
    pub comment: String,
    /// 至少有一个条目加密
    pub needs_password: bool,
}

/// 一次操作的统计结果
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub entries_done: u64,
    pub bytes_done: u64,
    pub skipped: u64,
    /// keep_broken 时收集的单条目错误
    pub errors: Vec<String>,
    pub elapsed_ms: u64,
}

/// 轻量探测结果，右键菜单渲染前调这个（不读整个归档，只读几百字节）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub is_archive: bool,
    pub format: String,
    pub format_label: String,
    pub container: Option<String>,
    pub caps: super::format::Caps,
    pub unsupported_reason: Option<String>,
    /// 分卷中的第几卷（1 起）
    pub volume_index: Option<u32>,
    /// 是不是分卷的非首卷：非首卷不能直接解，要提示用户找第一卷
    pub is_secondary_volume: bool,
    /// 解压默认目录名（剥掉扩展名）
    pub extract_dir_name: String,
}
