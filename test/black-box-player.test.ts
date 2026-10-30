import { describe, expect, test } from "bun:test";
import { StatePlayer } from "../web/public/black-box/player.js";

class FakeVideo {
  muted = false;
  playsInline = false;
  loop = true;
  currentTime = 0;
  src = "";
  playCount = 0;
  pauseCount = 0;
  loadCount = 0;
  playError = false;
  frameCallback: (() => void) | undefined;
  readonly classList = {
    values: new Set<string>(),
    add: (value: string) => this.classList.values.add(value),
    remove: (value: string) => this.classList.values.delete(value),
    contains: (value: string) => this.classList.values.has(value),
  };
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  getAttribute(name: string) {
    return name === "src" && this.src ? this.src : null;
  }

  load() {
    this.loadCount++;
  }

  play() {
    this.playCount++;
    return this.playError ? Promise.reject(new Error("play failed")) : Promise.resolve();
  }

  pause() {
    this.pauseCount++;
  }

  requestVideoFrameCallback(callback: () => void) {
    this.frameCallback = callback;
  }

  deliverFrame() {
    const callback = this.frameCallback;
    this.frameCallback = undefined;
    callback?.();
  }
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const activeVideo = (videos: FakeVideo[]) => videos.find(video => video.classList.contains("visible"));

async function startAt(state: "observe" | "evaluate" | "wait") {
  const videos = [new FakeVideo(), new FakeVideo()];
  const states: string[] = [];
  const errors: string[] = [];
  const player = new StatePlayer(videos, {
    onState: next => states.push(next),
    onError: error => errors.push(error),
  });
  player.request(state);
  await settle();
  expect(videos[1].frameCallback).toBeDefined();
  videos[1].deliverFrame();
  await settle();
  expect(activeVideo(videos)).toBe(videos[1]);
  return { videos, player, states, errors };
}

describe("Black Box StatePlayer", () => {
  test("plays every directed state transition at a loop boundary", async () => {
    const transitions = [
      ["observe", "evaluate"], ["observe", "wait"],
      ["evaluate", "observe"], ["evaluate", "wait"],
      ["wait", "observe"], ["wait", "evaluate"],
    ] as const;

    for (const [from, to] of transitions) {
      const { videos, player, states } = await startAt(from);
      const oldActive = activeVideo(videos);
      expect(oldActive).toBeDefined();

      player.request(to);
      oldActive!.emit("ended");
      await settle();

      const next = videos.find(video => video !== oldActive);
      expect(next?.src).toBe(`/black-box/assets/${from}-to-${to}.mp4`);
      expect(next?.playCount).toBe(1);
      expect(player.state).toBe(from);
      expect(states).toEqual([from]);
      expect(activeVideo(videos)).toBe(oldActive);

      next!.deliverFrame();
      await settle();
      expect(activeVideo(videos)).toBe(next);
      expect(player.state).toBe(from);

      next!.emit("ended");
      await settle();
      expect(player.state).toBe(to);
      expect(states).toEqual([from, to]);
    }
  });

  test("queues the latest requested state while a transition is buffering", async () => {
    const { videos, player, states } = await startAt("observe");
    const firstActive = activeVideo(videos)!;

    player.request("evaluate");
    firstActive.emit("ended");
    await settle();
    const firstTransition = videos.find(video => video !== firstActive)!;
    expect(firstTransition.src).toBe("/black-box/assets/observe-to-evaluate.mp4");

    player.request("wait");
    expect(player.desired).toBe("wait");
    expect(firstTransition.playCount).toBe(1);
    firstTransition.deliverFrame();
    await settle();

    firstTransition.emit("ended");
    await settle();
    const secondTransition = videos.find(video => video !== firstTransition)!;
    expect(secondTransition.src).toBe("/black-box/assets/evaluate-to-wait.mp4");
    expect(player.state).toBe("evaluate");
    expect(states).toEqual(["observe", "evaluate"]);

    secondTransition.deliverFrame();
    await settle();
    secondTransition.emit("ended");
    await settle();
    expect(player.state).toBe("wait");
    expect(states).toEqual(["observe", "evaluate", "wait"]);
  });

  test("does not interrupt the asynchronous initial load when desired state changes", async () => {
    const videos = [new FakeVideo(), new FakeVideo()];
    const player = new StatePlayer(videos);
    player.request("observe");
    await settle();
    expect(videos[1].src).toBe("/black-box/assets/observe-loop.mp4");
    expect(videos[1].playCount).toBe(1);

    player.request("evaluate");
    expect(videos[0].src).toBe("");
    expect(videos[0].playCount).toBe(0);
    expect(player.state).toBe("observe");

    videos[1].deliverFrame();
    await settle();
    expect(activeVideo(videos)).toBe(videos[1]);
    expect(videos[0].src).toBe("/black-box/assets/observe-to-evaluate.mp4");
    expect(videos[0].loadCount).toBe(1);
  });

  test("replays the same state as a loop without changing the state", async () => {
    const { videos, player } = await startAt("observe");
    const oldActive = activeVideo(videos)!;
    player.request("observe");
    expect(videos[0].src).toBe("/black-box/assets/observe-loop.mp4");
    oldActive.emit("ended");
    await settle();
    expect(videos[0].playCount).toBe(1);
    videos[0].deliverFrame();
    await settle();
    expect(activeVideo(videos)).toBe(videos[0]);
    expect(player.state).toBe("observe");
  });

  test("pauses and resumes motion while retaining the requested state", async () => {
    const { videos, player } = await startAt("observe");
    const pausesBefore = videos.map(video => video.pauseCount);
    player.request("evaluate");
    player.setMotion(false);
    expect(videos.map((video, index) => video.pauseCount - pausesBefore[index])).toEqual([1, 1]);
    expect(activeVideo(videos)).toBeUndefined();
    expect(player.state).toBe("evaluate");

    player.setMotion(true);
    await settle();
    const loading = videos.find(video => video.frameCallback);
    expect(loading).toBeDefined();
    expect(loading?.src).toBe("/black-box/assets/evaluate-loop.mp4");
    loading!.deliverFrame();
    await settle();
    expect(activeVideo(videos)).toBe(loading);
    expect(player.state).toBe("evaluate");
  });

  test("reports a failed next play without hiding the active frame", async () => {
    const { videos, player, errors } = await startAt("observe");
    const oldActive = activeVideo(videos)!;
    const next = videos.find(video => video !== oldActive)!;
    next.playError = true;

    player.request("evaluate");
    oldActive.emit("ended");
    await settle();

    expect(errors).toEqual(["Pulsa Reanudar animación para iniciar el vídeo."]);
    expect(activeVideo(videos)).toBe(oldActive);
    expect(oldActive.pauseCount).toBe(0);
    expect(player.state).toBe("observe");
  });
});
