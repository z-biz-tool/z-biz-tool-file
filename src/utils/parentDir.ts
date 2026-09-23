/**
 * 取路径的父目录（与 App 里 goUp 同一套口径：分隔符切分、去空段、拼回绝对路径）。
 *
 * 存在的理由：右键"加入图片库/加入音乐库"把**文件自己的路径**当成了媒体库的目录，
 * 于是画廊去 list_directory 一个文件，拿不到条目 —— 开出来是一座空馆，
 * 用户只看到"该目录下没有图片文件"，想不到是自己右键的那一项被当成了目录。
 */
export function parentOfPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  // Windows 的 "C:/work/a.jpg"：盘符那一段属于根，不能当成一层目录
  const win = /^[A-Za-z]:\//.test(slashed);
  const root = win ? slashed.slice(0, 2) + "/" : "/";
  const parts = slashed.split("/").filter(Boolean);
  if (win) parts.shift();
  parts.pop();
  if (!parts.length) return root;
  return root + parts.join("/");
}
