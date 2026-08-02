import { useState, useEffect, useRef, useMemo } from "react";
import { Button, Slider, Select, Tag, Tooltip, theme } from "antd";
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  SoundOutlined,
  RetweetOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useFileStore, getFileType } from "../stores/fileStore";
import { useTheme } from "../_shared";

interface Props {
  filePath: string;
  fileName: string;
}

type PlayMode = "sequence" | "loop" | "shuffle";

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
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function AudioPlayer({ filePath, fileName }: Props) {
  const { mode } = useTheme();
  const { token } = theme.useToken();
  const { fileList } = useFileStore();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(80);
  const [speed, setSpeed] = useState(1);
  const [playMode, setPlayMode] = useState<PlayMode>("sequence");

  // 同目录音频文件列表
  const playlist = useMemo(() => {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    return fileList.filter(
      (f) => !f.is_dir && getFileType(f.name) === "audio" && f.path.startsWith(dir)
    );
  }, [fileList, filePath]);

  const currentIndex = playlist.findIndex((f) => f.path === filePath);
  const fileUrl = convertFileSrc(filePath);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume / 100;
    audio.playbackRate = speed;
  }, [volume, speed]);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [filePath]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
    setPlaying(!playing);
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  };

  const playNext = () => {
    if (playlist.length === 0) return;
    let nextIndex: number;
    if (playMode === "shuffle") {
      nextIndex = Math.floor(Math.random() * playlist.length);
    } else {
      nextIndex = (currentIndex + 1) % playlist.length;
    }
    // 通过改变selectedFile触发
    useFileStore.getState().setSelectedFile(playlist[nextIndex]);
  };

  const playPrev = () => {
    if (playlist.length === 0) return;
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : playlist.length - 1;
    useFileStore.getState().setSelectedFile(playlist[prevIndex]);
  };

  const handleEnded = () => {
    if (playMode === "loop") {
      audioRef.current?.play();
    } else {
      playNext();
    }
  };

  const cyclePlayMode = () => {
    const modes: PlayMode[] = ["sequence", "loop", "shuffle"];
    const next = modes[(modes.indexOf(playMode) + 1) % modes.length];
    setPlayMode(next);
  };

  const playModeIcon =
    playMode === "loop" ? <RetweetOutlined /> : playMode === "shuffle" ? <SwapOutlined /> : <RetweetOutlined style={{ opacity: 0.4 }} />;

  const playModeLabel =
    playMode === "loop" ? "单曲循环" : playMode === "shuffle" ? "随机播放" : "顺序播放";

  const isDark = mode === "dark";
  const bg = isDark ? "#1a1a2e" : "#f5f5f5";
  const textColor = isDark ? "#d4d4d4" : "#333";

  const ext = fileName.split(".").pop()?.toUpperCase() || "AUDIO";

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: bg,
        color: textColor,
      }}
    >
      <audio
        ref={audioRef}
        src={fileUrl}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onDurationChange={() => setDuration(audioRef.current?.duration || 0)}
        onEnded={handleEnded}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      {/* 封面区 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
        }}
      >
        <div
          style={{
            width: 160,
            height: 160,
            borderRadius: 16,
            background: `linear-gradient(135deg, ${token.colorPrimaryBg}, ${token.colorPrimary})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 64,
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
          }}
        >
          🎵
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{fileName}</div>
          <Tag color="blue">{ext}</Tag>
        </div>
      </div>

      {/* 进度条 */}
      <div style={{ padding: "0 24px 8px" }}>
        <Slider
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={seek}
          tooltip={{ formatter: (v) => formatTime(v || 0) }}
          styles={{ track: { background: token.colorPrimary } }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            color: token.colorTextSecondary,
          }}
        >
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* 控制栏 */}
      <div
        style={{
          padding: "8px 24px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
        }}
      >
        <Tooltip title={playModeLabel}>
          <Button
            type={playMode !== "sequence" ? "primary" : "text"}
            size="small"
            icon={playModeIcon}
            onClick={cyclePlayMode}
          />
        </Tooltip>
        <Button
          type="text"
          icon={<StepBackwardOutlined style={{ fontSize: 18 }} />}
          onClick={playPrev}
          disabled={playlist.length <= 1}
        />
        <Button
          type="primary"
          shape="circle"
          size="large"
          icon={playing ? <PauseCircleOutlined style={{ fontSize: 28 }} /> : <PlayCircleOutlined style={{ fontSize: 28 }} />}
          onClick={togglePlay}
        />
        <Button
          type="text"
          icon={<StepForwardOutlined style={{ fontSize: 18 }} />}
          onClick={playNext}
          disabled={playlist.length <= 1}
        />
        <Select
          size="small"
          value={speed}
          onChange={setSpeed}
          options={SPEED_OPTIONS}
          style={{ width: 72 }}
        />
      </div>

      {/* 音量 + 播放列表 */}
      <div
        style={{
          padding: "0 24px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <SoundOutlined style={{ fontSize: 14, color: token.colorTextSecondary }} />
        <Slider
          min={0}
          max={100}
          value={volume}
          onChange={setVolume}
          style={{ flex: 1, minWidth: 80 }}
        />
        {playlist.length > 1 && (
          <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
            {currentIndex + 1}/{playlist.length}
          </span>
        )}
      </div>
    </div>
  );
}
