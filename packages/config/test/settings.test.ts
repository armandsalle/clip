import { afterEach, describe, expect, it } from "vite-plus/test";
import { modeOfStreamCreator, settings } from "../src/index.ts";

describe("settings", () => {
  afterEach(() => {
    delete process.env.CLIP_HYPERDRIVE_ID;
  });

  it("refuse le staging sans Hyperdrive propre (jamais la base de production)", () => {
    delete process.env.CLIP_HYPERDRIVE_ID;
    expect(() => settings("staging")).toThrow(/CLIP_HYPERDRIVE_ID/);
  });

  it("staging : ressources à lui, vrai Stream, base obligatoire, emails coupés", () => {
    process.env.CLIP_HYPERDRIVE_ID = "hyperdrive-staging";
    const s = settings("staging");
    expect(s.names).toEqual({
      web: "clip-web-staging",
      api: "clip-api-staging",
      jobs: "clip-jobs-staging",
    });
    expect(s.resources).toEqual({
      notifications: "clip-notifications-staging",
      pipeline: "clip-pipeline-staging",
      media: "clip-api-staging-media",
    });
    expect(s).toMatchObject({
      production: false,
      preview: false,
      deployed: true,
      remote: true,
      store: "postgres",
      hyperdriveId: "hyperdrive-staging",
      email: false,
      emailRouting: false,
      webhook: true,
      hostname: null,
      streamCreator: "clip-staging",
      streamDeleteAfterDays: 30,
    });
  });

  it("PR : inchangé (domaine pr-<n>, emails coupés)", () => {
    process.env.CLIP_HYPERDRIVE_ID = "hyperdrive-pr";
    expect(settings("pr-12")).toMatchObject({
      preview: true,
      deployed: true,
      hostname: "pr-12.clipshare.dev",
      email: false,
    });
  });

  it("production : ni staging ni PR", () => {
    expect(settings("production")).toMatchObject({
      deployed: false,
      email: true,
      hostname: "clipshare.dev",
    });
  });

  it("production : toujours Postgres, jamais l'URL de la machine qui déploie", () => {
    const before = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = "postgres://quelquun:secret@exemple/base";
      expect(settings("production")).toMatchObject({ store: "postgres", databaseUrl: undefined });
      delete process.env.DATABASE_URL;
      expect(settings("production").store).toBe("postgres");
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });
});

describe("modeOfStreamCreator", () => {
  it("reconnaît production, staging et PR, ignore le dev", () => {
    expect(modeOfStreamCreator("clip-production")).toBe("production");
    expect(modeOfStreamCreator("clip-staging")).toBe("staging");
    expect(modeOfStreamCreator("clip-pr-12")).toBe("pr-12");
    expect(modeOfStreamCreator("clip-dev")).toBeNull();
  });
});
