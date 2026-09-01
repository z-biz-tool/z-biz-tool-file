/**
 * AI File Manager Service
 * 提供智能文件管理功能：
 * - 文件智能分类
 * - 语义搜索
 * - 内容摘要
 * - 智能推荐
 */

import { invoke } from "@tauri-apps/api/core";

export interface AISearchResult {
  path: string;
  name: string;
  score: number;
  metadata: {
    summary?: string;
    tags?: string[];
    relatedFiles?: string[];
  };
}

export interface FileCategory {
  category: string;
  subcategory?: string;
  confidence: number;
  suggestedPath?: string;
}

export interface AIAction {
  action: 'rename' | 'move' | 'tag' | 'categorize';
  params: Record<string, unknown>;
  confidence: number;
  preview?: string;
}

/**
 * 智能语义搜索
 * 用户输入自然语言描述，AI 返回相关文件
 */
export async function semanticSearch(query: string): Promise<AISearchResult[]> {
  try {
    const results = await invoke<AISearchResult[]>("ai_semantic_search", { query });
    return results;
  } catch (error) {
    console.error("Semantic search failed:", error);
    return [];
  }
}

/**
 * 智能文件分类
 * 根据文件内容自动分类
 */
export async function categorizeFile(filePath: string): Promise<FileCategory> {
  try {
    const result = await invoke<FileCategory>("ai_categorize_file", { path: filePath });
    return result;
  } catch (error) {
    console.error("File categorization failed:", error);
    return {
      category: "unknown",
      confidence: 0,
    };
  }
}

/**
 * 批量智能分类
 * 对多个文件进行分类
 */
export async function batchCategorize(files: string[]): Promise<Record<string, FileCategory>> {
  try {
    const result = await invoke<Record<string, FileCategory>>("ai_batch_categorize", { files });
    return result;
  } catch (error) {
    console.error("Batch categorization failed:", error);
    return {};
  }
}

/**
 * 获取文件内容摘要
 */
export async function getFileSummary(filePath: string): Promise<string> {
  try {
    const summary = await invoke<string>("ai_get_summary", { path: filePath });
    return summary || "无法生成摘要";
  } catch (error) {
    console.error("Get file summary failed:", error);
    return "无法生成摘要";
  }
}

/**
 * 智能批量重命名
 * 根据内容自动生成重命名建议
 */
export async function suggestBatchRename(files: string[], pattern?: string): Promise<AIAction[]> {
  try {
    const actions = await invoke<AIAction[]>("ai_suggest_batch_rename", { files, pattern });
    return actions;
  } catch (error) {
    console.error("Suggest batch rename failed:", error);
    return [];
  }
}

/**
 * 智能推荐相关文件
 */
export async function getRelatedFiles(filePath: string): Promise<AISearchResult[]> {
  try {
    const results = await invoke<AISearchResult[]>("ai_get_related_files", { path: filePath });
    return results;
  } catch (error) {
    console.error("Get related files failed:", error);
    return [];
  }
}

/**
 * AI 文件整理建议
 */
export async function getIntelligentOrganizationSuggestion(
  directory: string
): Promise<AIAction[]> {
  try {
    const actions = await invoke<AIAction[]>("ai_intelligent_organization", { directory });
    return actions;
  } catch (error) {
    console.error("Get intelligent organization suggestion failed:", error);
    return [];
  }
}

/**
 * 智能标签建议
 */
export async function suggestTags(filePath: string): Promise<string[]> {
  try {
    const tags = await invoke<string[]>("ai_suggest_tags", { path: filePath });
    return tags;
  } catch (error) {
    console.error("Suggest tags failed:", error);
    return [];
  }
}

// 导出类型
export type { AISearchResult, FileCategory, AIAction };
