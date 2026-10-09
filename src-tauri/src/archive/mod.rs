//! 归档引擎总入口：探测格式 → 分发到后端 → 统一的任务 / 进度 / 取消。
//!
//! ## 这一层解决什么
//!
//! 六个后端的函数形状各不相同：tar 和单流压缩要多传一个 `Format`，rar / 7z 要多传密码，
//! zip 的注释单开一个函数，cab 的元信息也单开一个，追加只有 zip 和纯 tar 支持。
//! 前端不可能对着六种签名写分支，所以这里收成一件事——**探测一次格式，之后所有操作
//! 走同一条路**。
//!
//! ## 密码相关的错误必须分类
//!
//! `info` / `preflight` 返回 [`ArchiveError`] 而不是 `String`。前端要能区分三种情况：
//! 弹密码框、密码填错了抖一下框、包真的坏了。靠匹配中文措辞撑不住（改一个字前端就瞎），
//! 分类信息来自 rar / 7z 各自的 `open_status`，它们直接看底层库的错误码。
//!
//! ## 目录大小为什么在这一层补
//!
//! 目录条目的 size 在归档里几乎总是 0（zip / rar / 7z 都是），表格里一整列 "0 B"
//! 看着像坏了；7-Zip 和资源管理器显示的是子树合计。原先 zip / rar / 7z 三个后端
//! 各写了一份**一模一样**的汇总函数，而 tar 干脆没写（于是 tar 的目录列全是 0）。
//! 现在统一由 [`rollup_dir_sizes`] 在列举出口处补一次。

pub mod cab;
pub mod cmds;
pub mod format;
pub mod guard;
pub mod io;
pub mod job;
pub mod rar;
pub mod select;
pub mod sevenz;
pub mod single;
pub mod tar;
pub mod types;
pub mod zip;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

// `Caps` 不在这里再导一次：`archive` 是 crate 私有模块，导出去外面也拿不到，
// types.rs 直接用 `super::format::Caps` 就够了。
pub use format::Format;
pub use types::{
    ArchiveInfo, ArchiveMeta, CreateOptions, Entry, ExtractOptions, ProbeResult, Stats,
};

use job::Reporter;
use select::{map_output, single_root, Selector};

/// 列表条目数上限。
///
/// 这是**防御性**上限，不是 UI 上限：zip 炸弹可以塞几百万个 1 KB 条目，全部建成
/// `Entry` 再序列化成 JSON 发给前端会直接把 WebView 撑死。本机实测最大的真实包是
/// 8638 条（7.4 GB 的 3ds Max RAR5），离这个上限还很远。超限时 `ArchiveInfo.truncated`
/// 置真，前端要提示"列表不完整"。
pub const MAX_ENTRIES: usize = 50_000;

/// 冲突预览条数上限。前端只需要知道"有没有冲突"+ 给用户看几个例子，
/// 把 5 万个路径全推过去换不来任何东西。真实总数在 `ConflictReport.total` 里。
pub const CONFLICT_PREVIEW_CAP: usize = 1000;

// ============================================================================
// 错误分类
// ============================================================================

/// 打不开一个归档的原因。前端按 `kind` 分支，不要匹配 message。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ArchiveError {
    /// 需要密码才能继续。`encryptedHeaders` 为真时连文件名都是加密的，
    /// 不给密码连列表都拿不到——这句话要说给用户听，否则他会以为是包坏了。
    ///
    /// 容器上的 `rename_all` 只管变体名，字段得单独标（`rename_all_fields`
    /// 要 serde ≥ 1.0.166，不值得为这一个字段抬最低版本）。
    NeedPassword {
        message: String,
        #[serde(rename = "encryptedHeaders")]
        encrypted_headers: bool,
    },
    /// 密码给了，但不对。
    BadPassword { message: String },
    /// 其它失败：格式不支持、包损坏、IO 错误…
    Failed { message: String },
}

impl ArchiveError {
    pub fn message(&self) -> &str {
        match self {
            ArchiveError::NeedPassword { message, .. } => message,
            ArchiveError::BadPassword { message } => message,
            ArchiveError::Failed { message } => message,
        }
    }

    pub fn failed(message: impl Into<String>) -> ArchiveError {
        ArchiveError::Failed {
            message: message.into(),
        }
    }
}

impl From<String> for ArchiveError {
    fn from(m: String) -> ArchiveError {
        ArchiveError::Failed { message: m }
    }
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// 后端对"打不开"的归类。rar / 7z 各自实现（它们能拿到底层库的错误码），
/// 其它格式一律 `Ok`——它们的列表不需要密码，失败只会是"包坏了"。
#[derive(Debug, Clone)]
pub enum OpenStatus {
    Ok,
    NeedPassword {
        message: String,
        encrypted_headers: bool,
    },
    BadPassword {
        message: String,
    },
    Failed {
        message: String,
    },
}

impl OpenStatus {
    /// 手写转换而不是 `impl From<OpenStatus> for Result<(), ArchiveError>`：
    /// `Result` 是外部类型，把本地的 `ArchiveError` 包在里面过不了孤儿规则。
    pub fn into_result(self) -> Result<(), ArchiveError> {
        match self {
            OpenStatus::Ok => Ok(()),
            OpenStatus::NeedPassword {
                message,
                encrypted_headers,
            } => Err(ArchiveError::NeedPassword {
                message,
                encrypted_headers,
            }),
            OpenStatus::BadPassword { message } => Err(ArchiveError::BadPassword { message }),
            OpenStatus::Failed { message } => Err(ArchiveError::Failed { message }),
        }
    }
}

// ============================================================================
// 路由
// ============================================================================

/// 后端路由。24 个 `Format` 变体映射到 6 个后端，一次探测之后所有操作共用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Zip,
    SevenZ,
    Rar,
    Cab,
    Tar,
    Single,
}

impl Route {
    pub fn of(f: Format) -> Option<Route> {
        Some(match f {
            Format::Zip => Route::Zip,
            Format::SevenZ => Route::SevenZ,
            Format::Rar => Route::Rar,
            Format::Cab => Route::Cab,
            Format::Tar
            | Format::TarGz
            | Format::TarBz2
            | Format::TarXz
            | Format::TarZst
            | Format::TarLz4
            | Format::TarBr => Route::Tar,
            Format::Gz
            | Format::Bz2
            | Format::Xz
            | Format::Zst
            | Format::Lz4
            | Format::Br
            | Format::LzmaAlone => Route::Single,
            // 认得但不支持（iso/wim/ar/rpm/lzh/z）和彻底不认识的都走 None，
            // 由 unsupported_message 给出人话
            _ => return None,
        })
    }
}

fn unsupported_message(f: Format) -> String {
    match f.unsupported_reason() {
        Some(r) => format!("{}：{}", f.label(), r),
        None if f == Format::Unknown => "不是本程序认识的压缩格式。".to_string(),
        None => format!("{} 暂不支持。", f.label()),
    }
}

/// 探测 + 路由 + 能力检查。所有对外操作的共同前置。
fn route_of(path: &Path) -> Result<(format::Detection, Route), ArchiveError> {
    if !path.exists() {
        return Err(ArchiveError::failed(format!("文件不存在: {}", path.display())));
    }
    let det = format::detect(path);
    let caps = det.format.caps();
    let route = Route::of(det.format).ok_or_else(|| ArchiveError::failed(unsupported_message(det.format)))?;
    if !caps.list && !caps.extract {
        return Err(ArchiveError::failed(unsupported_message(det.format)));
    }
    Ok((det, route))
}

/// 扩展名说是某种包、真去打开却失败 → 十有八九是改过名的文件，或者压根不是压缩包。
///
/// 底层库这时候抛的是 "BadSignature"、"invalid literal/length or distance code" 之类，
/// 用户看了只会以为包坏了、去重下一遍。补一句"文件头对不上扩展名"，他才知道该查来源。
///
/// 只补 `Failed`：需要密码 / 密码不对是**正常**结果而不是异常，那两条 message 会原样
/// 显示给用户，措辞一改就等于替前端改了话术。
fn explain_open_failure(det: &format::Detection, e: ArchiveError) -> ArchiveError {
    if det.by_magic {
        return e;
    }
    match e {
        ArchiveError::Failed { message } => ArchiveError::failed(format!(
            "{}（文件名以 {} 结尾，但文件头不是 {} 的签名——它可能改过扩展名，或者根本不是压缩包）",
            message,
            det.format.extension(),
            det.format.label()
        )),
        other => other,
    }
}

// ============================================================================
// 探测（右键菜单渲染前调，只读几百字节）
// ============================================================================

pub fn probe(path: &Path) -> ProbeResult {
    let det = format::detect(path);
    let caps = det.format.caps();
    let route = Route::of(det.format);

    // "非首卷"由各格式的权威来源判定：rar 问 UnRAR，cab 问 cabinet_set_index，
    // 其余只能靠文件名里的卷号。名字判不准的地方宁可说 false——误报会让用户
    // 对着一个能正常解压的包看到"请找第一卷"，比漏报更烦人。
    let is_secondary = match (det.format, route) {
        (Format::Rar, _) => rar::secondary_volume_hint(path).is_some(),
        (Format::Cab, _) => cab::set_index(path).map(|i| i > 0).unwrap_or(false),
        // 7z 的任何分卷都读不了（引擎不拼卷），第一卷也不例外
        (Format::SevenZ, _) => det.volume_index.is_some(),
        _ => det.volume_index.map(|n| n > 1).unwrap_or(false),
    };

    ProbeResult {
        is_archive: route.is_some() && (caps.list || caps.extract),
        format: det.format.id().to_string(),
        format_label: det.format.label().to_string(),
        container: det.container.map(|s| s.to_string()),
        caps,
        unsupported_reason: det.format.unsupported_reason().map(|s| s.to_string()),
        volume_index: det.volume_index,
        is_secondary_volume: is_secondary,
        extract_dir_name: format::stem_for_extract(path),
    }
}

/// 7z 的 `.7z.001` 分卷：第一卷的签名头读得到，但数据跨卷，引擎拼不起来。
/// 不提前拦住的话会解到一半报"数据损坏"，用户以为是包坏了。
fn sevenz_split_refusal(det: &format::Detection) -> Option<String> {
    if det.format == Format::SevenZ && det.volume_index.is_some() {
        Some(sevenz::split_volume_message())
    } else {
        None
    }
}

/// 分卷 ZIP 的兄弟卷。zip crate 不做跨卷拼接（中央目录在最后一卷），
/// 所以 `.zip` 主卷在有 `.z01` 时也可能打不开。**只在真的打不开时**拿它当解释，
/// 免得误伤能正常打开的包。
fn zip_split_sibling(path: &Path) -> Option<PathBuf> {
    let orig = path.file_name()?.to_string_lossy().to_string();
    let lower = orig.to_lowercase();
    let parent = path.parent()?;
    // 用 orig 而不是 lower 拼名字：Windows 路径大小写不敏感，但这句话是要显示给用户的
    if lower.ends_with(".zip") && orig.len() > 4 {
        let s = parent.join(format!("{}.z01", &orig[..orig.len() - 4]));
        if s.exists() {
            return Some(s);
        }
    }
    // `.z01/.z02…` → 找同名的 `.zip`
    if let Some(dot) = lower.rfind('.') {
        let tail = &lower[dot + 1..];
        if tail.len() == 2 && tail.starts_with('z') && tail[1..].chars().all(|c| c.is_ascii_digit())
        {
            let s = parent.join(format!("{}.zip", &orig[..dot]));
            if s.exists() {
                return Some(s);
            }
        }
    }
    None
}

// ============================================================================
// 列举
// ============================================================================

/// 各后端的 list 签名不统一，这里抹平：一律返回 `(条目表, 归档级元信息)`。
fn list_entries(
    path: &Path,
    det: &format::Detection,
    route: Route,
    pw: Option<&str>,
) -> Result<(Vec<Entry>, ArchiveMeta), ArchiveError> {
    if let Some(m) = sevenz_split_refusal(det) {
        return Err(ArchiveError::failed(m));
    }
    // 只有 rar / 7z 需要在这里先分类："要密码"和"包坏了"在底层库里是同一个失败。
    // zip 的目录不加密，tar / cab 压根没有密码这回事，对它们再 open 一次纯属
    // 把下面 list 马上就要做的同一件事提前做一遍。
    if matches!(route, Route::Rar | Route::SevenZ) {
        open_status(path, route, pw)?;
    }

    match route {
        Route::Zip => match zip::list(path) {
            Ok(entries) => {
                let mut meta = ArchiveMeta::default();
                meta.comment = zip::archive_comment(path);
                meta.needs_password = entries.iter().any(|e| e.encrypted);
                meta.multipart = det.volume_index.is_some() || zip_split_sibling(path).is_some();
                Ok((entries, meta))
            }
            // 打不开且有兄弟卷 → 几乎可以肯定是分卷，说清楚比丢一句"不是有效的 ZIP"有用
            Err(e) => match zip_split_sibling(path) {
                Some(sib) => Err(ArchiveError::failed(format!(
                    "{}（这是分卷 ZIP，中央目录在最后一卷；同目录发现了 {}，\
                     zip 引擎不做跨卷拼接，请先用 7-Zip 合并）",
                    e,
                    sib.display()
                ))),
                None => Err(ArchiveError::failed(e)),
            },
        },
        Route::SevenZ => sevenz::list(path, pw).map_err(ArchiveError::failed),
        Route::Rar => rar::list(path, pw).map_err(ArchiveError::failed),
        Route::Cab => Ok((
            cab::list(path).map_err(ArchiveError::failed)?,
            cab::archive_meta(path),
        )),
        Route::Tar => Ok((
            tar::list(path, det.format).map_err(ArchiveError::failed)?,
            ArchiveMeta::default(),
        )),
        Route::Single => Ok((
            single::list(path, det.format).map_err(ArchiveError::failed)?,
            ArchiveMeta::default(),
        )),
    }
}

/// 打开一个归档并归类失败原因。只有 rar / 7z 需要密码，其余格式一律放行到
/// 真正的 list/extract 里去报错——它们的失败只会是"包坏了"，没有第二种解释。
pub fn open_status(path: &Path, route: Route, pw: Option<&str>) -> Result<(), ArchiveError> {
    let status = match route {
        Route::Zip => zip::open_status(path),
        Route::Rar => rar::open_status(path, pw),
        Route::SevenZ => sevenz::open_status(path, pw),
        _ => OpenStatus::Ok,
    };
    status.into_result()
}

/// 目录条目的 size 汇总成子树合计。见模块头"目录大小为什么在这一层补"。
///
/// 幂等：只读非目录条目的 size，然后覆盖目录条目的 size，跑两遍结果一样。
pub fn rollup_dir_sizes(entries: &mut [Entry]) {
    let mut sums: HashMap<String, u64> = HashMap::new();
    for e in entries.iter() {
        if e.is_dir || e.size == 0 {
            continue;
        }
        let segs: Vec<&str> = e.path.split('/').collect();
        // k 是祖先层数；k == segs.len() 时拼出来的是文件自己，不算祖先
        for k in 1..segs.len() {
            *sums.entry(segs[..k].join("/")).or_insert(0) += e.size;
        }
    }
    for e in entries.iter_mut() {
        if e.is_dir {
            if let Some(s) = sums.get(&e.path) {
                e.size = *s;
            }
        }
    }
}

pub fn info(path: &Path, password: Option<&str>) -> Result<ArchiveInfo, ArchiveError> {
    let (det, route) = route_of(path)?;
    let pw = password.filter(|s| !s.is_empty());
    let (mut entries, meta) =
        list_entries(path, &det, route, pw).map_err(|e| explain_open_failure(&det, e))?;
    rollup_dir_sizes(&mut entries);

    let caps = det.format.caps();
    let truncated = entries.len() >= MAX_ENTRIES;
    // 目录的 size 是子树合计，加进总量会重复计算
    let total_size = entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
    let total_packed = entries.iter().filter(|e| !e.is_dir).map(|e| e.packed).sum();
    let multipart = meta.multipart || det.volume_index.is_some();
    let volumes = if meta.volumes.is_empty() && multipart {
        vec![path.to_string_lossy().to_string()]
    } else {
        meta.volumes.clone()
    };

    Ok(ArchiveInfo {
        path: path.to_string_lossy().to_string(),
        format: det.format.id().to_string(),
        format_label: det.format.label().to_string(),
        container: det.container.map(|s| s.to_string()),
        entry_count: entries.len(),
        total_size,
        total_packed,
        needs_password: meta.needs_password || entries.iter().any(|e| e.encrypted),
        encrypted_headers: meta.encrypted_headers,
        solid: meta.solid,
        multipart,
        volumes,
        comment: meta.comment,
        caps,
        truncated,
        entries,
    })
}

// ============================================================================
// 开工前体检
// ============================================================================

/// 起 job 之前的同步体检：格式认得吗？要密码吗？密码对吗？
///
/// 放在起 job 之前跑，是为了让"需要密码"这种失败**立刻**返回给前端，而不是变成
/// 一个刚出生就报错的任务——那样前端得先建进度条再拆掉，还会闪一下红。
/// 只读归档头部，对上万条目的包也是毫秒级。
pub fn preflight(path: &Path, pw: Option<&str>) -> Result<format::Detection, ArchiveError> {
    let (det, route) = route_of(path)?;
    if !det.format.caps().extract {
        return Err(ArchiveError::failed(unsupported_message(det.format)));
    }
    if let Some(m) = sevenz_split_refusal(&det) {
        return Err(ArchiveError::failed(m));
    }
    // rar / 7z 每次都问：它们的"要密码"和"包坏了"在底层库里是同一个失败，
    // 不先分类前端就不知道该弹密码框还是该报错。
    // 其余格式只在**魔数没命中**（格式纯靠扩展名猜的）时才真去打开一遍：改名成 .zip
    // 的普通文件在这里当场现形，而正常的包不必为此多读一次中央目录。
    if matches!(route, Route::Rar | Route::SevenZ) || !det.by_magic {
        open_status(path, route, pw).map_err(|e| explain_open_failure(&det, e))?;
    }
    Ok(det)
}

// ============================================================================
// 解压 / 校验 / 压缩
// ============================================================================

pub fn extract(
    path: &Path,
    det: &format::Detection,
    dest: &Path,
    opts: &ExtractOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let route = Route::of(det.format).ok_or_else(|| unsupported_message(det.format))?;
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {}", e))?;
    match route {
        Route::Zip => zip::extract(path, dest, opts, reporter, cancel),
        Route::SevenZ => sevenz::extract(path, dest, opts, reporter, cancel),
        Route::Rar => rar::extract(path, dest, opts, reporter, cancel),
        Route::Cab => cab::extract(path, dest, opts, reporter, cancel),
        Route::Tar => tar::extract(path, det.format, dest, opts, reporter, cancel),
        Route::Single => single::extract(path, det.format, dest, opts, reporter, cancel),
    }
}

/// 完整性校验：能查的东西各格式差别很大，`caps.test` 已经如实标了。
///
/// - zip / 7z / rar：逐条 CRC，真校验
/// - cab：crate 在读每个数据块时验 CAB 自己的 checksum，等价于全包校验
/// - tar / 单流：tar 自己没有 CRC，查的是"外层压缩流完整 + 每个头部合法"，
///   这已经覆盖了下载被截断和磁盘位翻转这两种最常见的坏包
pub fn test(
    path: &Path,
    det: &format::Detection,
    password: Option<&str>,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let route = Route::of(det.format).ok_or_else(|| unsupported_message(det.format))?;
    if !det.format.caps().test {
        return Err(format!("{} 不支持完整性校验。", det.format.label()));
    }
    let pw = password.filter(|s| !s.is_empty());
    let opts = ExtractOptions {
        password: pw.map(|s| s.to_string()),
        ..Default::default()
    };
    match route {
        Route::Zip => zip::test(path, &opts, reporter, cancel),
        Route::SevenZ => sevenz::test(path, &opts, reporter, cancel),
        Route::Rar => rar::test(path, &opts, reporter, cancel),
        Route::Cab => cab::test(path, &opts, reporter, cancel),
        Route::Tar => tar::test(path, det.format, reporter, cancel),
        Route::Single => single::test(path, det.format, reporter, cancel),
    }
}

/// 压缩前的同步体检。命令层在起 job 之前调它，好让"格式不认识"、"这个格式不能创建"、
/// "压缩包在被压目录里面"、"要求了不支持的分卷"这几类错误**立刻**返回，
/// 而不是变成一个刚出生就失败的任务。
pub fn create_preflight(
    sources: &[PathBuf],
    dest: &Path,
    opts: &CreateOptions,
) -> Result<Format, String> {
    let fmt = Format::from_id(&opts.format).ok_or_else(|| {
        format!(
            "不认识的可写格式: {}（可选: {}）",
            opts.format,
            format::writable_formats()
                .iter()
                .map(|f| f.id.as_str())
                .collect::<Vec<_>>()
                .join(" / ")
        )
    })?;
    if !fmt.caps().create {
        return Err(format!("{} 只能解压，不能创建。", fmt.label()));
    }
    // 分卷能不能写是能力表里的一项，别等到后端各自再判一遍（判据会漂）
    if opts.volume_size.unwrap_or(0) > 0
        && !format::writable_formats()
            .iter()
            .find(|f| f.id == fmt.id())
            .map(|f| f.supports_volumes)
            .unwrap_or(false)
    {
        return Err(format!(
            "{} 不支持分卷压缩。需要分卷请改选别的格式，或取消分卷设置。",
            fmt.label()
        ));
    }
    prepare_sources(sources, dest)?;
    Ok(fmt)
}

pub fn create(
    sources: &[PathBuf],
    dest: &Path,
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let fmt = create_preflight(sources, dest, opts)?;
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }
    match Route::of(fmt) {
        Some(Route::Zip) => zip::create(sources, dest, opts, reporter, cancel),
        Some(Route::SevenZ) => sevenz::create(sources, dest, opts, reporter, cancel),
        Some(Route::Tar) => tar::create(sources, dest, fmt, opts, reporter, cancel),
        Some(Route::Single) => single::create(sources, dest, fmt, opts, reporter, cancel),
        // Rar（UnRAR 许可证禁止写）和 Cab（只读）走不到这里：caps.create 已经拦掉了
        _ => Err(format!("{} 不支持创建。", fmt.label())),
    }
}

/// 追加前的同步体检。追加是**原地改写**现有归档，比新建更容易出事，
/// 所以"这个格式到底能不能追加"必须在动手之前说清楚。
pub fn add_preflight(archive: &Path, sources: &[PathBuf]) -> Result<Format, String> {
    let det = format::detect(archive);
    let route = Route::of(det.format).ok_or_else(|| unsupported_message(det.format))?;
    if !det.format.caps().add {
        return Err(match route {
            Route::SevenZ => sevenz::add_unsupported(),
            _ => format!(
                "{} 不支持追加（要加东西就得整体重写）。请用「新建压缩」重新打包。",
                det.format.label()
            ),
        });
    }
    prepare_sources(sources, archive)?;
    Ok(det.format)
}

pub fn add(
    archive: &Path,
    sources: &[PathBuf],
    opts: &CreateOptions,
    reporter: &mut Reporter,
    cancel: &AtomicBool,
) -> Result<Stats, String> {
    let fmt = add_preflight(archive, sources)?;
    match Route::of(fmt) {
        Some(Route::Zip) => zip::add(archive, sources, opts, reporter, cancel),
        Some(Route::Tar) => tar::add(archive, sources, opts, reporter, cancel),
        // caps.add 为真的只有 zip 和纯 tar
        _ => Err(format!("{} 不支持追加。", fmt.label())),
    }
}

/// 压缩前的公共检查：源要存在，压缩包不能把自己压进去。
///
/// 第二条是真实的坑：右键一个目录选"压缩到本目录下的 x.zip"，边压边把自己写进去，
/// 轻则文件越滚越大，重则磁盘写满。7-Zip 会拒绝，这里也拒绝。
fn prepare_sources(sources: &[PathBuf], dest: &Path) -> Result<(), String> {
    if sources.is_empty() {
        return Err("没有要压缩的内容。".to_string());
    }
    for s in sources {
        if !s.exists() {
            return Err(format!("找不到要压缩的内容: {}", s.display()));
        }
        if s == dest {
            return Err("压缩包不能和被压缩的文件是同一个。".to_string());
        }
        if s.is_dir() && guard::is_within(s, dest) {
            return Err(format!(
                "压缩包 {} 在要压缩的目录里面，会边压边把自己写进去。请换个保存位置。",
                dest.display()
            ));
        }
    }
    Ok(())
}

/// 解压前探测重名。前端在开工**之前**调这个，拿到用户的选择再决定 `overwrite` 策略——
/// 引擎是同步阻塞的，中途弹窗会把整条解压停住。
///
/// 返回 `(真实冲突总数, 前 N 条路径预览)`。目录不算冲突：解到已存在的目录上是合并，
/// 这是 7-Zip 和资源管理器共同的语义，把它算成冲突会让"解压到当前文件夹"永远弹警告。
pub fn conflicts(
    path: &Path,
    dest: &Path,
    opts: &ExtractOptions,
) -> Result<(usize, Vec<String>), ArchiveError> {
    let (det, route) = route_of(path)?;
    let pw = opts.password.as_deref().filter(|s| !s.is_empty());
    let (entries, _) = list_entries(path, &det, route, pw)?;

    let sel = Selector::new(opts.entries.clone(), opts.include_children);
    let strip_root = if opts.strip_root {
        single_root(entries.iter().map(|e| e.path.as_str()))
    } else {
        None
    };
    let mut total = 0usize;
    let mut preview = Vec::new();
    for e in entries.iter().filter(|e| !e.is_dir) {
        if !sel.matches(&e.path) {
            continue;
        }
        let rel = map_output(&e.path, strip_root.as_deref(), opts.flatten);
        if rel.is_empty() {
            continue;
        }
        // 越界的条目名不该出现在"重名"列表里（它会被 guard 拒掉，不是被覆盖）
        let Ok(target) = guard::safe_join(dest, &rel) else {
            continue;
        };
        if target.exists() {
            total += 1;
            if preview.len() < CONFLICT_PREVIEW_CAP {
                preview.push(rel);
            }
        }
    }
    Ok((total, preview))
}

#[cfg(test)]
mod tests {
    use super::job::{Kind, Reporter};
    use super::*;
    use crate::test_bridge::TempDir;
    use std::fs;

    fn rep(kind: Kind) -> Reporter {
        Reporter::detached("mod-test".into(), kind, "a.zip".into(), String::new())
    }

    fn flag() -> AtomicBool {
        AtomicBool::new(false)
    }

    fn entry(path: &str, is_dir: bool, size: u64) -> Entry {
        Entry {
            index: 0,
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or("").to_string(),
            is_dir,
            size,
            packed: 0,
            modified: 0,
            method: String::new(),
            encrypted: false,
            crc: 0,
            comment: String::new(),
            symlink_target: String::new(),
        }
    }

    #[test]
    fn rollup_sums_subtrees_and_is_idempotent() {
        let mut v = vec![
            entry("src", true, 0),
            entry("src/a.txt", false, 100),
            entry("src/sub", true, 0),
            entry("src/sub/b.bin", false, 5000),
            entry("top.txt", false, 7),
        ];
        rollup_dir_sizes(&mut v);
        let sz = |p: &str| v.iter().find(|e| e.path == p).unwrap().size;
        assert_eq!(sz("src/sub"), 5000);
        assert_eq!(sz("src"), 5100, "要含孙目录");
        assert_eq!(sz("top.txt"), 7, "文件自己不动");

        let once: Vec<u64> = v.iter().map(|e| e.size).collect();
        rollup_dir_sizes(&mut v);
        let twice: Vec<u64> = v.iter().map(|e| e.size).collect();
        assert_eq!(once, twice, "跑两遍必须同结果，否则调用点顺序会变成隐式依赖");
    }

    #[test]
    fn route_covers_every_supported_format() {
        // 能力表说能解的格式，必须都有路由；否则前端会渲染出一个点了就报错的菜单项
        for f in [
            Format::Zip,
            Format::SevenZ,
            Format::Rar,
            Format::Cab,
            Format::Tar,
            Format::TarGz,
            Format::TarBz2,
            Format::TarXz,
            Format::TarZst,
            Format::TarLz4,
            Format::TarBr,
            Format::Gz,
            Format::Bz2,
            Format::Xz,
            Format::Zst,
            Format::Lz4,
            Format::Br,
            Format::LzmaAlone,
        ] {
            assert!(Route::of(f).is_some(), "{} 有能力表却没有路由", f.id());
            assert!(f.caps().extract, "{} 有路由却说不能解压", f.id());
            assert!(f.caps().test, "{} 有路由却说不能校验", f.id());
        }
        for f in [
            Format::Iso,
            Format::Wim,
            Format::Ar,
            Format::Rpm,
            Format::Lzh,
            Format::Z,
            Format::Unknown,
        ] {
            assert!(Route::of(f).is_none(), "{} 不该有路由", f.id());
        }
    }

    #[test]
    fn writable_formats_all_have_a_create_route() {
        for f in format::writable_formats() {
            let fmt = Format::from_id(&f.id).unwrap_or_else(|| panic!("from_id 认不出 {}", f.id));
            assert!(fmt.caps().create, "{} 列在可写清单里却不能创建", f.id);
            assert!(
                matches!(
                    Route::of(fmt),
                    Some(Route::Zip) | Some(Route::SevenZ) | Some(Route::Tar) | Some(Route::Single)
                ),
                "{} 没有 create 路由",
                f.id
            );
        }
    }

    #[test]
    fn unsupported_formats_explain_themselves() {
        assert!(unsupported_message(Format::Iso).contains("挂载"));
        assert!(unsupported_message(Format::Unknown).contains("压缩格式"));
        // 认得但不支持的格式，probe 要带上原因，前端才能显示一句人话而不是"未知格式"
        let dir = TempDir::new("mod-probe-iso");
        let iso = dir.join("x.iso");
        fs::write(&iso, [0u8; 64]).unwrap();
        let p = probe(&iso);
        assert!(p.unsupported_reason.is_some());
        assert!(!p.is_archive, "不能解的东西不该自称归档");
        assert_eq!(p.extract_dir_name, "x");
    }

    #[test]
    fn probe_recognizes_by_extension_even_when_the_file_is_gone() {
        // 探测不要求文件存在：文件刚被移走时右键菜单也可能调它，
        // 这时候该说"看起来是 zip"，而不是崩掉或说"不是归档"
        let dir = TempDir::new("mod-probe-missing");
        let p = probe(&dir.join("nope.zip"));
        assert_eq!(p.format, "zip");
        assert_eq!(p.extract_dir_name, "nope");
    }

    #[test]
    fn probe_says_no_for_a_plain_file() {
        let dir = TempDir::new("mod-probe-plain");
        let f = dir.join("notes.txt");
        fs::write(&f, b"just text").unwrap();
        let p = probe(&f);
        assert!(!p.is_archive, "普通文本不能自称归档，否则右键会多出一排没用的菜单");
        assert_eq!(p.format, "unknown");
    }

    #[test]
    fn dispatcher_round_trips_probe_info_extract_conflicts() {
        let dir = TempDir::new("mod-roundtrip");
        let src = dir.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub/a.txt"), b"hello").unwrap();
        fs::write(src.join("top.bin"), vec![7u8; 3000]).unwrap();

        let dest = dir.join("out.zip");
        let copts = CreateOptions {
            format: "zip".into(),
            ..Default::default()
        };
        create(&[src], &dest, &copts, &mut rep(Kind::Create), &flag()).unwrap();

        let p = probe(&dest);
        assert!(p.is_archive && p.caps.extract && p.caps.create && p.caps.add);
        assert!(!p.is_secondary_volume && p.volume_index.is_none());
        assert_eq!(p.extract_dir_name, "out");

        let det = preflight(&dest, None).unwrap();
        assert_eq!(det.format, Format::Zip);

        let inf = info(&dest, None).unwrap();
        assert_eq!(inf.format, "zip");
        assert_eq!(inf.format_label, "ZIP");
        assert!(!inf.truncated && !inf.solid && !inf.needs_password);
        assert_eq!(inf.total_size, 3005, "目录的汇总额不能重复计进总量");
        let sub = inf
            .entries
            .iter()
            .find(|e| e.path == "src/sub" && e.is_dir)
            .expect("zip 里该有目录条目");
        assert_eq!(sub.size, 5, "目录大小要在列举出口处汇总");

        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let ex = ExtractOptions::default();
        assert_eq!(conflicts(&dest, &out, &ex).unwrap().0, 0);
        extract(&dest, &det, &out, &ex, &mut rep(Kind::Extract), &flag()).unwrap();
        assert_eq!(fs::read(out.join("src/sub/a.txt")).unwrap(), b"hello");

        let (total, preview) = conflicts(&dest, &out, &ex).unwrap();
        assert_eq!(total, 2, "两个文件都该报冲突，目录不算（解到已存在目录是合并）");
        assert_eq!(preview.len(), 2);
    }

    #[test]
    fn create_refuses_to_swallow_itself() {
        let dir = TempDir::new("mod-self");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("a.txt"), b"x").unwrap();

        // 压缩包放在被压目录里面：右键"压缩到此处"最容易撞上
        let inside = sub.join("out.zip");
        let e = prepare_sources(&[sub.clone()], &inside).unwrap_err();
        assert!(e.contains("边压边把自己写进去"), "实际: {}", e);
        // 和被压文件同名
        let f = sub.join("a.txt");
        assert!(prepare_sources(&[f.clone()], &f).is_err());
        // 正常情况放行
        assert!(prepare_sources(&[sub], &dir.join("ok.zip")).is_ok());
        // 源不存在 / 没有源
        assert!(prepare_sources(&[dir.join("nope")], &dir.join("o.zip")).is_err());
        assert!(prepare_sources(&[], &dir.join("o.zip")).is_err());
    }

    #[test]
    fn test_op_verifies_and_detects_rot() {
        let dir = TempDir::new("mod-test-op");
        let src = dir.join("s");
        fs::create_dir_all(&src).unwrap();
        // 明文里埋一段独一无二的标记，后面靠它在包里精确定位数据区
        let needle = b"ROT-DETECT-NEEDLE";
        fs::write(src.join("a.bin"), needle.repeat(20_000)).unwrap();
        let dest = dir.join("t.zip");
        // store 而不是 deflate：数据原样躺在包里，翻位才翻得准。
        // deflate 之后拿 `bytes.len()/2` 当"数据区"是碰运气——压缩流只有两百来字节，
        // 一半的位置十有八九落在中央目录的文件名上，那种损坏 CRC 根本抓不出来，
        // 用例就会假绿（这正是它第一次真跑起来时的样子）。
        create(
            &[src],
            &dest,
            &CreateOptions {
                format: "zip".into(),
                method: Some("store".into()),
                ..Default::default()
            },
            &mut rep(Kind::Create),
            &flag(),
        )
        .unwrap();

        let det = preflight(&dest, None).unwrap();
        let st = test(&dest, &det, None, &mut rep(Kind::Test), &flag()).unwrap();
        assert!(st.entries_done >= 1);

        // 翻一个数据区的位：CRC 必须抓出来。
        // 注意各后端的 `test` 都返回 Ok(stats)，把坏条目记在 stats.errors 里
        // （和解压共用一套"部分成功"口径）；判失败是 cmds::drive 对 Kind::Test 做的事。
        let mut bytes = fs::read(&dest).unwrap();
        let at = bytes
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("store 模式下明文必须原样躺在包里");
        bytes[at + needle.len() / 2] ^= 0xFF;
        fs::write(&dest, &bytes).unwrap();
        let det = preflight(&dest, None).unwrap();
        let st = test(&dest, &det, None, &mut rep(Kind::Test), &flag()).unwrap();
        assert!(!st.errors.is_empty(), "翻了数据位却没查出损坏，CRC 白校验了");
        assert_eq!(st.entries_done, 0, "坏条目不该被算成校验通过");
        assert!(st.errors[0].contains("a.bin"), "{}", st.errors[0]);
    }

    /// 改过扩展名的普通文件。底层库只会抛 "invalid signature" 之类，用户看了
    /// 以为包坏了、去重下一遍；`by_magic == false` 时必须补一句"文件头对不上扩展名"。
    #[test]
    fn misnamed_archive_error_says_the_header_disagrees() {
        let dir = TempDir::new("mod-misnamed");
        let fake = dir.join("notes.zip");
        fs::write(&fake, b"this is plainly not a zip archive").unwrap();

        // preflight 要在起 job **之前**认出来，而不是让它变成一个刚出生就失败的任务
        let err = preflight(&fake, None).unwrap_err();
        assert!(
            matches!(err, ArchiveError::Failed { .. }),
            "认不出内容时不该被归成需要密码: {:?}",
            err
        );
        let msg = err.message().to_string();
        assert!(msg.contains("文件头不是"), "{}", msg);
        assert!(msg.contains(".zip"), "{}", msg);

        // info 走的是另一条路（list_entries），同一句话也得说清楚
        let via_info = info(&fake, None).unwrap_err().message().to_string();
        assert!(via_info.contains("文件头不是"), "{}", via_info);

        // 真的是 zip 时不能加这句：by_magic 为真，加上去等于冤枉用户
        let src = dir.join("s");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"hello").unwrap();
        let real = dir.join("real.zip");
        create(
            &[src],
            &real,
            &CreateOptions { format: "zip".into(), ..Default::default() },
            &mut rep(Kind::Create),
            &flag(),
        )
        .unwrap();
        assert!(preflight(&real, None).is_ok());
        assert!(info(&real, None).is_ok());
    }
}

