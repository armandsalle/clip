import { describe, expect, it } from "@effect/vitest";
import { actionFor } from "../src/lib/shortcuts.ts";
import { parseTime, savePosition, shareLink, startPosition } from "../src/lib/position.ts";

const memory = () => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
};

describe("position de lecture", () => {
  it("lit les formats de ?t=", () => {
    expect(parseTime("80")).toBe(80);
    expect(parseTime("1:20")).toBe(80);
    expect(parseTime("1:02:03")).toBe(3723);
    expect(parseTime("1m20s")).toBe(80);
    expect(parseTime("2h")).toBe(7200);
    expect(parseTime("bientôt")).toBeNull();
    expect(parseTime("")).toBeNull();
  });

  it("reprend à la position mémorisée pour cet onglet", () => {
    const storage = memory();
    expect(startPosition("v1", new URLSearchParams(), storage)).toEqual({
      time: 0,
      shareParam: false,
    });
    savePosition("v1", 84.7, storage);
    expect(startPosition("v1", new URLSearchParams(), storage)).toEqual({
      time: 84,
      shareParam: false,
    });
    expect(startPosition("v2", new URLSearchParams(), storage).time).toBe(0);
  });

  it("un lien de partage ?t= l'emporte, puis doit être retiré de l'URL", () => {
    const storage = memory();
    savePosition("v1", 84, storage);
    expect(startPosition("v1", new URLSearchParams("t=1m30s"), storage)).toEqual({
      time: 90,
      shareParam: true,
    });
    expect(startPosition("v1", new URLSearchParams("t=n'importe"), storage)).toEqual({
      time: 84,
      shareParam: true,
    });
  });

  it("tolère un stockage indisponible", () => {
    const broken = {
      getItem: () => {
        throw new Error("bloqué");
      },
      setItem: () => {
        throw new Error("bloqué");
      },
    };
    expect(startPosition("v1", new URLSearchParams(), broken).time).toBe(0);
    expect(() => savePosition("v1", 10, broken)).not.toThrow();
  });

  it("fabrique un lien qui démarre au bon moment", () => {
    expect(shareLink("https://clipshare.dev", "v1")).toBe("https://clipshare.dev/v/v1");
    expect(shareLink("https://clipshare.dev", "v1", 84.9)).toBe("https://clipshare.dev/v/v1?t=84");
    expect(shareLink("https://clipshare.dev", "v1", 0.4)).toBe("https://clipshare.dev/v/v1");
  });
});

describe("raccourcis", () => {
  const key = (k: string, tagName = "BODY", mods: Partial<{ ctrlKey: boolean }> = {}) => ({
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
    target: { tagName },
  });

  it("associe les touches du design", () => {
    expect(actionFor(key(" "))).toBe("toggle");
    expect(actionFor(key("j"))).toBe("back");
    expect(actionFor(key("L"))).toBe("forward");
    expect(actionFor(key("c"))).toBe("captions");
    expect(actionFor(key("n"))).toBe("nextChapter");
    expect(actionFor(key("k"))).toBe("commentHere");
    expect(actionFor(key("f"))).toBe("fullscreen");
    expect(actionFor(key("?"))).toBe("help");
    expect(actionFor(key("x"))).toBeNull();
  });

  it("se tait pendant la saisie et avec les modificateurs", () => {
    expect(actionFor(key("c", "TEXTAREA"))).toBeNull();
    expect(actionFor(key("f", "INPUT"))).toBeNull();
    expect(actionFor(key("c", "BODY", { ctrlKey: true }))).toBeNull();
    expect(actionFor(key(" ", "BUTTON"))).toBeNull();
  });
});
