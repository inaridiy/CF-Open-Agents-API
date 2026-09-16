/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { strToU8, unzipSync, zipSync } from "fflate";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

import { readSkillZip } from "../../packages/agent-api/src/skill-zip.js";

const client = (tenant = "skills") =>
  new OpenAI({
    apiKey: tenant,
    baseURL: "https://api.test/v1",
    maxRetries: 0,
    fetch: (input, init) => exports.default.fetch(new Request(input, init)),
  });
const source = (description: string) =>
  `---\nname: example\ndescription: ${description}\n---\nSkill instructions.\n`;
const file = (description: string) =>
  new File([source(description)], "SKILL.md", { type: "text/markdown" });
const filesFor = (kind: string): File[] => {
  if (kind === "empty") return [];
  if (kind === "missing-frontmatter") return [new File(["not a skill"], "SKILL.md")];
  if (kind === "duplicate") return [file("a"), file("b")];
  if (kind === "invalid-zip") return [new File(["not zip"], "skill.zip")];
  if (kind === "yaml-alias")
    return [new File(["---\nname: &name example\ndescription: *name\n---\nbody"], "SKILL.md")];
  return [
    new File(
      [
        zipSync(
          kind === "traversal"
            ? { "../SKILL.md": strToU8(source("bad")) }
            : { "README.md": strToU8("missing") },
        ),
      ],
      "skill.zip",
    ),
  ];
};
afterEach(() => reset());

it("preserves safe executable permissions and rejects invalid ZIP metadata before publishing", async () => {
  const api = client().skills;
  const original = zipSync({
    "SKILL.md": strToU8(source("scripts")),
    "scripts/run.sh": [strToU8("#!/bin/sh\necho proof\n"), { os: 3, attrs: 0o100755 << 16 }],
  });
  const skill = await api.create({ files: new File([original], "skill.zip") });
  const stored = new Uint8Array(await (await api.content.retrieve(skill.id)).arrayBuffer());
  expect(readSkillZip(stored, 32 * 1024 * 1024).get("scripts/run.sh")?.executable).toBe(true);
  const collision = zipSync({
    "SKILL.md": strToU8(source("bad")),
    scripts: strToU8("file"),
    "scripts/run.sh": strToU8("data"),
  });
  const link = zipSync({
    "SKILL.md": strToU8(source("bad")),
    link: [strToU8("/etc/passwd"), { os: 3, attrs: 0o120777 << 16 }],
  });
  const bomb = zipSync({
    "SKILL.md": strToU8(source("bad")),
    "asset.bin": new Uint8Array(1_000_000),
  });
  const central: number[] = [];
  const view = new DataView(bomb.buffer);
  for (let at = 0; at + 46 <= bomb.length; at++)
    if (view.getUint32(at, true) === 0x02014b50) central.push(at);
  const entry = central[1];
  if (entry === undefined) throw new Error("Fixture is missing an asset entry");
  view.setUint32(entry + 24, 1, true);
  view.setUint32(view.getUint32(entry + 42, true) + 22, 1, true);
  const corrupt = original.slice();
  const crcView = new DataView(corrupt.buffer);
  for (let at = 0; at + 46 <= corrupt.length; at++)
    if (crcView.getUint32(at, true) === 0x02014b50) {
      crcView.setUint32(at + 16, 1, true);
      crcView.setUint32(crcView.getUint32(at + 42, true) + 14, 1, true);
      break;
    }
  for (const archive of [collision, link, bomb, corrupt, original.slice(0, -10)])
    await expect(api.create({ files: new File([archive], "skill.zip") })).rejects.toMatchObject({
      status: 400,
    });
  expect((await api.list()).data.map((item) => item.id)).toEqual([skill.id]);
});

it("uses the official SDK for directory/ZIP uploads, immutable versions, defaults, pagination and content", async () => {
  const api = client().skills;
  const skill = await api.create(
    { files: [file("original"), new File(["binary\0asset"], "assets/data.bin")] },
    { headers: { "Idempotency-Key": "skill-upload" } },
  );
  expect(skill).toMatchObject({
    name: "example",
    description: "original",
    default_version: "1",
    latest_version: "1",
  });
  const zip = new File([zipSync({ "example/SKILL.md": strToU8(source("updated")) })], "skill.zip");
  const versions = await Promise.all([
    api.versions.create(skill.id, { files: zip }),
    api.versions.create(skill.id, { files: file("third") }),
  ]);
  expect(new Set(versions.map((version) => version.version))).toEqual(new Set(["2", "3"]));
  expect(await api.retrieve(skill.id)).toMatchObject({
    default_version: "1",
    latest_version: "3",
    description: "original",
  });
  const listed = [];
  for await (const version of api.versions.list(skill.id, { limit: 1, order: "asc" }))
    listed.push(version);
  expect(listed.map((version) => version.version)).toEqual(["1", "2", "3"]);
  expect((await api.update(skill.id, { default_version: "2" })).default_version).toBe("2");
  await abortAllDurableObjects();
  const firstContent = unzipSync(
    new Uint8Array(
      await (await api.versions.content.retrieve("1", { skill_id: skill.id })).arrayBuffer(),
    ),
  );
  expect(new TextDecoder().decode(firstContent["SKILL.md"])).toBe(source("original"));
  expect(new TextDecoder().decode(firstContent["assets/data.bin"])).toBe("binary\0asset");
  const defaultContent = await (await api.content.retrieve(skill.id)).arrayBuffer();
  expect(new TextDecoder().decode(unzipSync(new Uint8Array(defaultContent))["SKILL.md"])).not.toBe(
    source("original"),
  );
  await api.versions.delete("3", { skill_id: skill.id });
  expect((await api.retrieve(skill.id)).latest_version).toBe("2");
  expect(
    (await api.versions.create(skill.id, { files: file("fourth"), default: true })).version,
  ).toBe("4");
  expect((await api.retrieve(skill.id)).default_version).toBe("4");
  await expect(api.versions.delete("4", { skill_id: skill.id })).rejects.toMatchObject({
    status: 409,
  });
  await expect(client("other").skills.content.retrieve(skill.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    client("other").skills.versions.create(skill.id, { files: file("wrong") }),
  ).rejects.toMatchObject({ status: 404 });
  await api.delete(skill.id);
  await expect(api.retrieve(skill.id)).rejects.toMatchObject({ status: 404 });
  expect((await api.list()).data).toEqual([]);
});

it("deduplicates retried uploads without allocating another version and rejects conflicting retries", async () => {
  const api = client().skills;
  const options = { headers: { "Idempotency-Key": "create" } };
  const first = await api.create({ files: file("same") }, options);
  await abortAllDurableObjects();
  expect(await api.create({ files: file("same") }, options)).toEqual(first);
  await expect(api.create({ files: file("changed") }, options)).rejects.toMatchObject({
    status: 409,
  });
  const versionOptions = { headers: { "Idempotency-Key": "version" } };
  const version = await api.versions.create(first.id, { files: file("version") }, versionOptions);
  expect(await api.versions.create(first.id, { files: file("version") }, versionOptions)).toEqual(
    version,
  );
  expect((await api.versions.list(first.id)).data).toHaveLength(2);
});

it.each([
  "empty",
  "missing-frontmatter",
  "traversal",
  "missing-manifest",
  "duplicate",
  "invalid-zip",
  "yaml-alias",
])("rejects %s uploads without publishing metadata", async (kind) => {
  const api = client().skills;
  const files = filesFor(kind);
  await expect(api.create({ files })).rejects.toMatchObject({ status: 400 });
  expect((await api.list()).data).toEqual([]);
});
