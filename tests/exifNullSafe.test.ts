/**
 * 回归门禁：EXIF 数字字段拿到 null 时不许崩。
 *
 * 背景（2026-11-04 线上实际崩过）：
 * 一张**没有 GPS** 的普通照片，后端返回
 *   { latitude: null, longitude: null, altitude: null, ... }
 * 前端当时写的是 `if (exif.latitude !== undefined)` —— `null !== undefined` 成立，
 * 于是进分支执行 `null.toFixed(6)`，抛
 *   TypeError: null is not an object (evaluating 'e.latitude.toFixed')
 * 整块预览被 ErrorBoundary 接走，页面上只剩「这一片显示出错了」。
 *
 * 根因不是笔误，是**类型撒谎**：Rust 侧字段是 Option<f64>，serde 默认把 None
 * 序列化成 JSON null（结构体上没有 skip_serializing_if）。前端把类型写成
 * `latitude?: number` 之后，TS 认为"要么数字要么没有"，null 这条路径压根不存在，
 * 编译器也就帮不上忙。
 *
 * 所以这里的用例一律**照着后端真实返回写 null**，不写 undefined ——
 * 写成 undefined 的话测试会"通过"，但那正是当初漏掉的那条路径。
 */
import { describe, expect, it } from "vitest";
import { buildExifItems, hasDisplayableExif, type ExifInfo } from "../src/utils/exifItems";

/** 后端 read_exif 对一个"啥都没有"的 JPEG 的真实返回形状 */
const EMPTY_FROM_BACKEND: ExifInfo = {
  make: null,
  model: null,
  date_time: null,
  exposure_time: null,
  f_number: null,
  iso: null,
  focal_length: null,
  pixel_x_dimension: null,
  pixel_y_dimension: null,
  latitude: null,
  longitude: null,
  altitude: null,
  lens_model: null,
};

describe("EXIF 空值安全", () => {
  it("全 null 的后端返回不抛异常，且不产出任何一行", () => {
    // 这条就是当初崩掉的那份数据。改成 expect(...).not.toThrow() 也行，
    // 但直接断言结果更明确：既没崩，也不该凭空造出 GPS 行
    expect(() => buildExifItems(EMPTY_FROM_BACKEND)).not.toThrow();
    expect(buildExifItems(EMPTY_FROM_BACKEND)).toEqual([]);
  });

  it("只有相机型号、GPS 为 null —— 该出相机行，不该出 GPS 行", () => {
    const items = buildExifItems({
      ...EMPTY_FROM_BACKEND,
      make: "Apple",
      model: "iPhone 15 Pro",
    });
    expect(items).toEqual([["相机", "Apple iPhone 15 Pro"]]);
    expect(items.some(([k]) => k === "GPS")).toBe(false);
    expect(items.some(([k]) => k === "海拔")).toBe(false);
  });

  it("经纬度有一边是 null 就不出 GPS 行（半条坐标没有意义）", () => {
    const onlyLat = buildExifItems({ ...EMPTY_FROM_BACKEND, latitude: 31.23, longitude: null });
    expect(onlyLat.some(([k]) => k === "GPS")).toBe(false);

    const onlyLon = buildExifItems({ ...EMPTY_FROM_BACKEND, latitude: null, longitude: 121.47 });
    expect(onlyLon.some(([k]) => k === "GPS")).toBe(false);
  });

  it("完整坐标正常格式化到 6 位小数", () => {
    const items = buildExifItems({
      ...EMPTY_FROM_BACKEND,
      latitude: 31.230416,
      longitude: 121.473701,
    });
    expect(items).toEqual([["GPS", "31.230416, 121.473701"]]);
  });

  it("海拔 0 是合法值，不能被当成空", () => {
    // 0 是 falsy —— 如果哪天有人把判空改成 `if (exif.altitude)`，海平面照片就丢字段了
    const items = buildExifItems({ ...EMPTY_FROM_BACKEND, altitude: 0 });
    expect(items).toEqual([["海拔", "0.0m"]]);
  });

  it("NaN / Infinity 也不许进格式化（后端将来若改算法可能带出来）", () => {
    const items = buildExifItems({
      ...EMPTY_FROM_BACKEND,
      latitude: Number.NaN,
      longitude: Number.POSITIVE_INFINITY,
      altitude: Number.NaN,
    });
    expect(items).toEqual([]);
  });

  it("字段缺失（undefined，老版本缓存）同样安全", () => {
    expect(() => buildExifItems({})).not.toThrow();
    expect(buildExifItems({})).toEqual([]);
  });
});

describe("hasDisplayableExif 判空", () => {
  it("null / undefined / 空对象都不显示面板", () => {
    expect(hasDisplayableExif(null)).toBe(false);
    expect(hasDisplayableExif(undefined)).toBe(false);
    expect(hasDisplayableExif(EMPTY_FROM_BACKEND)).toBe(false);
  });

  it("只靠 GPS 也要能显示面板（这是当初触发崩溃的那条路径）", () => {
    // 关键点：只有 GPS 有值 → 面板必须渲染 → 才走到 latitude.toFixed
    // 判空若写错，这里就是崩溃现场
    expect(
      hasDisplayableExif({ ...EMPTY_FROM_BACKEND, latitude: 31.2, longitude: 121.4 }),
    ).toBe(true);
  });

  it("只有 iso 也算有内容", () => {
    expect(hasDisplayableExif({ ...EMPTY_FROM_BACKEND, iso: "100" })).toBe(true);
  });
});
