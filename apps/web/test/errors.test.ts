import { describe, expect, it } from "@effect/vitest";
import {
  Forbidden,
  InvalidTransition,
  OutOfRange,
  VideoId,
  VideoNotFound,
  VideoNotReady,
} from "@clip/domain";
import { TooManyRequests } from "@clip/contract";
import { messageFor, UNKNOWN_ERROR } from "../src/api/errors.ts";

describe("messageFor", () => {
  it("donne un message propre à chaque erreur du contrat", () => {
    const errors = [
      new VideoNotFound({ id: VideoId.make("00000000-0000-4000-8000-000000000000") }),
      new Forbidden(),
      new VideoNotReady({ status: "Encoding" }),
      new OutOfRange({ time: 9, duration: 5 }),
      new InvalidTransition({ from: "Deleted", event: "Rename" }),
      new TooManyRequests({ action: "create" }),
    ];
    const messages = errors.map((e) => messageFor(e._tag));
    expect(messages).not.toContain(UNKNOWN_ERROR);
    expect(new Set(messages).size).toBe(errors.length);
  });

  it("retombe sur un message générique, sans afficher le détail technique", () => {
    expect(messageFor("HttpClientError")).toBe(UNKNOWN_ERROR);
    expect(messageFor(undefined)).toBe(UNKNOWN_ERROR);
    expect(messageFor("toString")).toBe(UNKNOWN_ERROR);
  });
});
