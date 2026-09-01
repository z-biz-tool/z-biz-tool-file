import { invoke } from "@tauri-apps/api/core";

/**
 * 文件分类结果
 */
export interface FileCategory {
  type: string; // image, document, video, audio, archive, code, other
  sub_type: string; // 具体子类型
  topic?: string; // 主题（AI 推断）
  confidence: number; // 置信度
  tags: string[]; // 推荐标签
}

/**
 * 整理计划
 */
export interface OrganizePlan {
  source: string;
  target: string;
  action: OrganizeAction;
  rule_name: string;
  created_at: number;
}

/**
 * 整理动作
 */
export interface OrganizeAction {
  type: string;
  target?: string;
  tags?: string[];
  pattern?: string;
  days?: number;
}

/**
 * 智能整理器服务
 */

/**
 * 分类单个文件
 */
export async function categorizeFile(path: string): Promise<FileCategory> {
  try {
    const result = await invoke<FileCategory>("organizer_categorize", { path });
    return result;
  } catch (error) {
    console.error("分类文件失败:", error);
    return {
      type: "other",
      sub_type: "",
      confidence: 0,
      tags: [],
    };
  }
}

/**
 * 批量整理目录
 */
export async function organizeDirectory(rootPath: string): Promise<OrganizePlan[]> {
  try {
    const result = await invoke<{ plans: OrganizePlan[] }>(
      "organizer_organize_directory",
      { rootPath }
    );
    return result.plans || [];
  } catch (error) {
    console.error("整理目录失败:", error);
    return [];
  }
}

/**
 * 获取分类统计
 */
export async function getCategories(): Promise<Record<string, number>> {
  try {
    const result = await invoke<{ categories: Record<string, number> }>(
      "organizer_get_categories"
    );
    return result.categories || {};
  } catch (error) {
    console.error("获取分类失败:", error);
    return {};
  }
}

/**
 * 智能标签生成
 */
export async function generateTags(path: string): Promise<string[]> {
  try {
    const category = await categorizeFile(path);
    return category.tags;
  } catch (error) {
    console.error("生成标签失败:", error);
    return [];
  }
}

/**
 * 智能文件重命名建议
 */
export async function suggestRename(path: string): Promise<string> {
  try {
    const category = await categorizeFile(path);
    
    const ext = path.split(".").pop() || "";
    const date = new Date().toISOString().split("T")[0];
    
    // 根据类型生成有意义的文件名
    let prefix = "";
    switch (category.type) {
      case "image":
        prefix = "photo";
        break;
      case "document":
        prefix = "doc";
        break;
      case "video":
        prefix = "video";
        break;
      case "audio":
        prefix = "audio";
        break;
      case "code":
        prefix = "code";
        break;
      default:
        prefix = "file";
    }
    
    return `${prefix}_${date}_${Math.random().toString(36).substr(2, 6)}.${ext}`;
  } catch (error) {
    console.error("建议重命名失败:", error);
    return "";
  }
}

/**
 * 智能归档建议
 */
export async function suggestArchive(
  path: string,
  days: number = 90
): Promise<boolean> {
  try {
    // 简单实现：检查文件修改时间
    const metadata = await invoke<{ modified: number }>("get_file_metadata", {
      path,
    });
    
    const now = Date.now();
    const modified = metadata.modified * 1000; // 转换为毫秒
    const diffDays = (now - modified) / (1000 * 60 * 60 * 24);
    
    return diffDays > days;
  } catch (error) {
    console.error("检查归档条件失败:", error);
    return false;
  }
}
