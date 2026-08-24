import { useState, useEffect, useRef } from "react";
import { Button, Slider, Select, Tooltip } from "antd";
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  CameraOutlined,
  SoundOutlined,
} from "@ant-design/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useFileStore, getFileType } from "../stores/fileStore";
import { useTheme } from "../_shared";

interface Props {
  filePath: string;
  fileName: string;
}

const SPEED_OPTIONS = [
  { value: 0.5, label: "0.5x" },
  { value: 0.75, label: "0.75x" },
  { value: 1, label: "1x" },
  { value: 1.25, label: "1.25x" },
  { value: 1.5, label: "1.5x" },
  { value: 2, label: "2x" },
];

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function VideoPlayer({ filePath, fileName }: Props) {
  const { mode } = useTheme();
  const { fileList } = useFileStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(80);
  const [speed, setSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileUrl = convertFileSrc(filePath);

  // 同目录视频列表
  const videoList = fileList.filter(
    (f) => !f.is_dir && getFileType(f.name) === "video"
  );
  const currentIndex = videoList.findIndex((f) => f.path === filePath);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume / 100;
    video.playbackRate = speed;
  }, [volume, speed]);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [filePath]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.pause();
    } else {
      video.play();
    }
    setPlaying(!playing);
  };

  const seek = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    if (isFullscreen) {
      await document.exitFullscreen();
    } else {
      await containerRef.current.requestFullscreen();
    }
    setIsFullscreen(!isFullscreen);
  };

  const togglePiP = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await video.requestPictureInPicture();
    }
  };

  const screenshot = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName.replace(/\.[^.]+$/, "")}_screenshot.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const playNext = () => {
    if (videoList.length <= 1) return;
    const next = (currentIndex + 1) % videoList.length;
    useFileStore.getState().setSelectedFile(videoList[next]);
  };

  const playPrev = () => {
    if (videoList.length <= 1) return;
    const prev = currentIndex > 0 ? currentIndex - 1 : videoList.length - 1;
    useFileStore.getState().setSelectedFile(videoList[prev]);
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (playing) setShowControls(false);
    }, 3000);
  };

  const isDark = mode === "dark";

  return (
    <div
      ref={containerRef}
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "#000" }}
      onMouseMove={handleMouseMove}
    >
      {/* 视频区 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          cursor: "pointer",
        }}
        onClick={togglePlay}
      >
        <video
          ref={videoRef}
          src={fileUrl}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
          onDurationChange={() => setDuration(videoRef.current?.duration || 0)}
          onEnded={playNext}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={(e) => {
            const v = e.currentTarget;
            const code = v.error?.code;
            const message = v.error?.message || "未知错误";
            // 1=ABORTED, 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
            // eslint-disable-next-line no-console
            console.error("[VideoPlayer] 视频加载失败", {
              code,
              message,
              src: fileUrl,
              filePath,
            });
          }}
          onLoadedMetadata={() => {
            // eslint-disable-next-line no-console
            console.info("[VideoPlayer] 元数据已加载", { duration: videoRef.current?.duration });
          }}
        />
        {/* 播放/暂停大按钮 */}
        {!playing && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <PlayCircleOutlined style={{ fontSize: 40, color: "#fff" }} />
          </div>
        )}
      </div>

      {/* 控制栏 */}
      <div
        style={{
          padding: "8px 16px",
          background: isDark ? "rgba(0,0,0,0.85)" : "rgba(30,30,30,0.9)",
          color: "#fff",
          transition: "opacity 0.3s",
          opacity: showControls ? 1 : 0,
        }}
      >
        {/* 进度条 */}
        <Slider
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={seek}
          tooltip={{ formatter: (v) => formatTime(v || 0) }}
          styles={{
            track: { background: "#1677ff" },
            rail: { background: "rgba(255,255,255,0.2)" },
          }}
        />

        {/* 按钮行 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, minWidth: 90 }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <Button type="text" size="small" icon={<PlayCircleOutlined />} onClick={playPrev} style={{ color: "#fff" }}>
            上一曲
          </Button>
          <Button
            type="text"
            size="small"
            icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            onClick={togglePlay}
            style={{ color: "#fff", fontSize: 16 }}
          />
          <Button type="text" size="small" icon={<PlayCircleOutlined />} onClick={playNext} style={{ color: "#fff" }}>
            下一曲
          </Button>

          <div style={{ flex: 1 }} />

          <Select
            size="small"
            value={speed}
            onChange={setSpeed}
            options={SPEED_OPTIONS}
            style={{ width: 72 }}
            popupMatchSelectWidth={false}
          />

          <Tooltip title="截图">
            <Button
              type="text"
              size="small"
              icon={<CameraOutlined />}
              onClick={screenshot}
              style={{ color: "#fff" }}
            />
          </Tooltip>

          <div style={{ display: "flex", alignItems: "center", gap: 4, width: 100 }}>
            <SoundOutlined style={{ fontSize: 14 }} />
            <Slider
              min={0}
              max={100}
              value={volume}
              onChange={setVolume}
              styles={{
                track: { background: "#1677ff" },
                rail: { background: "rgba(255,255,255,0.2)" },
              }}
            />
          </div>

          <Tooltip title="画中画">
            <Button
              type="text"
              size="small"
              style={{ color: "#fff", fontSize: 12 }}
              onClick={togglePiP}
            >
              PiP
            </Button>
          </Tooltip>

          <Tooltip title={isFullscreen ? "退出全屏" : "全屏"}>
            <Button
              type="text"
              size="small"
              icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleFullscreen}
              style={{ color: "#fff" }}
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
