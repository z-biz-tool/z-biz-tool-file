/**
 * EXIF → 展示用「标签 / 值」两列。
 *
 * 这段逻辑本来内联在 FileContentPreview 的 ExifPanel 里，抽出来有两个原因：
 *
 * 1. **能被测**。崩溃点（null.toFixed）在 JSX 内部，node 环境跑不了渲染；
 *    抽成纯函数后可以用后端真实返回的形状（null，而不是 undefined）直接断言。
 *
 * 2. **类型必须诚实**。Rust 侧的 `ExifInfo` 字段都是 `Option<T>`，serde 默认把
 *    `None` 序列化成 JSON `null`（结构体上没有 `skip_serializing_if`）。
 *    所以类型写成 `foo?: number` 是错的 —— 它暗示"要么有值要么没有"，而实际
 *    第三种情况是"显式是 null"。只判 `!== undefined` 会让 null 长驱直入。
 *
 * 2026-11-04 线上崩过一次：一张没有 GPS 的普通照片，
 * `exif.latitude` 是 null → `null.toFixed(6)` 抛
 * `TypeError: null is not an object (evaluating 'e.latitude.toFixed')`，
 * 整个预览区被 ErrorBoundary 接走，显示「这一片显示出错了」。
 */

export interface ExifInfo {
  make?: string | null;
  model?: string | null;
  date_time?: string | null;
  exposure_time?: string | null;
  f_number?: string | null;
  iso?: string | null;
  focal_length?: string | null;
  pixel_x_dimension?: number | null;
  pixel_y_dimension?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  lens_model?: string | null;
}

/** EXIF 里是否"有值得展示的东西"（决定要不要渲染整个面板）。 */
export function hasDisplayableExif(exif: ExifInfo | null | undefined): exif is ExifInfo {
  if (!exif) return false;
  return !!(
    exif.make ||
    exif.model ||
    exif.date_time ||
    exif.iso ||
    Number.isFinite(exif.latitude)
  );
}

/**
 * 摊平成两列。数字字段一律先过 `Number.isFinite` ——
 * 它同时挡掉 null / undefined / NaN / Infinity，比 `!= null` 更严，
 * 也比 `!== undefined` 正确（后者放过 null，正是上次崩的原因）。
 */
export function buildExifItems(exif: ExifInfo): Array<[string, string]> {
  const items: Array<[string, string]> = [];

  if (exif.make || exif.model) {
    items.push(["相机", `${exif.make ?? ""} ${exif.model ?? ""}`.trim()]);
  }
  if (exif.lens_model) items.push(["镜头", exif.lens_model]);
  if (exif.date_time) items.push(["拍摄时间", exif.date_time]);
  if (exif.focal_length) items.push(["焦距", exif.focal_length]);
  if (exif.f_number) items.push(["光圈", exif.f_number]);
  if (exif.exposure_time) items.push(["快门", exif.exposure_time]);
  if (exif.iso) items.push(["ISO", exif.iso]);

  // 尺寸不做数值格式化（直接拼字符串），null 是 falsy，用 && 就够
  if (exif.pixel_x_dimension && exif.pixel_y_dimension) {
    items.push(["尺寸", `${exif.pixel_x_dimension} × ${exif.pixel_y_dimension}`]);
  }

  if (Number.isFinite(exif.latitude) && Number.isFinite(exif.longitude)) {
    items.push([
      "GPS",
      `${exif.latitude!.toFixed(6)}, ${exif.longitude!.toFixed(6)}`,
    ]);
  }
  if (Number.isFinite(exif.altitude)) {
    items.push(["海拔", `${exif.altitude!.toFixed(1)}m`]);
  }

  return items;
}
