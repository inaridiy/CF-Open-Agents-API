/** Executed by Python inside the assigned Sandbox, before agent execution. */
export const installCapabilityArchive = String.raw`
import json, pathlib, shutil, stat, sys, zipfile
archive, destination, kind, name, description = sys.argv[1:]
root = pathlib.Path(destination)
with zipfile.ZipFile(archive) as bundle:
    entries = bundle.infolist()
    if len(entries) > 10000 or sum(entry.file_size for entry in entries) > 200 * 1024 * 1024:
        raise ValueError("Capability archive exceeds extraction limits")
    for entry in entries:
        path = pathlib.PurePosixPath(entry.filename)
        mode = entry.external_attr >> 16
        if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or stat.S_ISLNK(mode):
            raise ValueError("Invalid capability archive path")
    if root.exists(): shutil.rmtree(root)
    root.mkdir(parents=True)
    for entry in entries:
        target = root / entry.filename
        if entry.is_dir(): target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, target.open("wb") as output: shutil.copyfileobj(source, output)
            target.chmod(0o755 if (entry.external_attr >> 16) & 0o111 else 0o644)
if kind == "plugin":
    manifests = list(root.glob("*/.codex-plugin/plugin.json"))
    if len(manifests) != 1: raise ValueError("Expected one plugin folder")
    manifest = json.loads(manifests[0].read_text())
    if manifest.get("name") != name or manifest.get("description") != description:
        raise ValueError("Plugin metadata does not match its manifest")
    selected = manifests[0].parent.parent
else:
    skills = list(root.glob("SKILL.md")) + list(root.glob("*/SKILL.md"))
    if len(skills) != 1: raise ValueError("Expected one skill folder")
    selected = skills[0].parent
print(json.dumps(str(selected)))
`;
