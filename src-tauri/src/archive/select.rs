//! 条目选择：把用户勾的那些行，翻译成"哪些归档内路径要落地"。
//!
//! 三个语义必须分清，混了就会出现"勾了一个文件夹结果什么都没解出来"：
//! - 勾中目录本身 → 要不要连它的子树？由 `include_children` 决定（默认要，
//!   和 7-Zip / Explorer 的直觉一致）。
//! - `strip_root` → 归档只有一个顶层目录时，把它剥掉，解出来不套一层壳。
//! - `flatten` → 完全不要目录结构，全平铺。

use std::collections::HashSet;

pub struct Selector {
    wanted: Option<HashSet<String>>,
    include_children: bool,
}

impl Selector {
    pub fn new(entries: Option<Vec<String>>, include_children: bool) -> Selector {
        let wanted = entries
            .filter(|v| !v.is_empty())
            .map(|v| v.into_iter().map(|s| normalize(&s)).collect::<HashSet<_>>());
        Selector {
            wanted,
            include_children,
        }
    }

    pub fn matches(&self, entry_path: &str) -> bool {
        let Some(w) = &self.wanted else { return true };
        let p = normalize(entry_path);
        if w.contains(&p) {
            return true;
        }
        if self.include_children {
            // 勾了 `a/b`，那 `a/b/c.txt` 也要出来
            return w.iter().any(|sel| p.starts_with(&format!("{}/", sel)));
        }
        false
    }
}

/// 统一分隔符、去掉首尾 '/' 和 '.' 段，让 `./a/b/` 与 `a/b` 等价。
/// tar 里非常常见 `./` 前缀，不归一化的话"勾选"永远匹配不上。
pub fn normalize(p: &str) -> String {
    let unified = p.replace('\\', "/");
    let parts: Vec<&str> = unified
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    parts.join("/")
}

/// 归档只有一个顶层目录时返回它的名字，否则 None。
/// 判据是"所有条目的第一段都相同，且第一段是目录"。
pub fn single_root<'a>(paths: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut root: Option<String> = None;
    let mut count = 0usize;
    for p in paths {
        let n = normalize(p);
        if n.is_empty() {
            continue;
        }
        count += 1;
        let first = n.split('/').next().unwrap_or("").to_string();
        match &root {
            None => root = Some(first),
            Some(r) if *r == first => {}
            Some(_) => return None,
        }
    }
    if count < 2 {
        // 只有一个条目时"剥壳"会让用户找不到东西，宁可留着
        return None;
    }
    root
}

/// 把归档内路径映射成落地的相对路径（应用 strip_root / flatten）
pub fn map_output(entry_path: &str, strip_root: Option<&str>, flatten: bool) -> String {
    let n = normalize(entry_path);
    if flatten {
        return n.rsplit('/').next().unwrap_or("").to_string();
    }
    if let Some(root) = strip_root {
        if let Some(rest) = n.strip_prefix(&format!("{}/", root)) {
            return rest.to_string();
        }
        if n == *root {
            return String::new();
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_equates_dot_prefixed_paths() {
        assert_eq!(normalize("./a/b/"), "a/b");
        assert_eq!(normalize("a\\b"), "a/b");
        assert_eq!(normalize("/a/b"), "a/b");
    }

    #[test]
    fn selector_matches_tar_style_entries() {
        let s = Selector::new(Some(vec!["a".into()]), true);
        assert!(s.matches("./a"));
        assert!(s.matches("a/b.txt"));
        assert!(!s.matches("ab.txt"));
        assert!(!s.matches("b/c"));
    }

    #[test]
    fn selector_without_children_only_hits_exact() {
        let s = Selector::new(Some(vec!["a".into()]), false);
        assert!(s.matches("a"));
        assert!(!s.matches("a/b"));
    }

    #[test]
    fn empty_selection_means_all() {
        // 空选择 = 全选，这是 `matches` 的语义，不是另一个 all() 标志位
        assert!(Selector::new(None, true).matches("anything"));
        assert!(Selector::new(Some(vec![]), true).matches("anything"));
    }

    #[test]
    fn single_root_detection() {
        assert_eq!(
            single_root(["top/a.txt", "top/b/c.txt"].into_iter()),
            Some("top".to_string())
        );
        assert_eq!(single_root(["a.txt", "top/b.txt"].into_iter()), None);
        assert_eq!(single_root(["only.txt"].into_iter()), None);
    }

    #[test]
    fn map_output_applies_strip_and_flatten() {
        assert_eq!(map_output("top/a/b.txt", Some("top"), false), "a/b.txt");
        assert_eq!(map_output("top/a/b.txt", None, true), "b.txt");
        assert_eq!(map_output("top", Some("top"), false), "");
        assert_eq!(map_output("other/x", Some("top"), false), "other/x");
    }
}
