/* GLB pipeline for the canopy world's Meshy assets.

   Usage:
     bun tools/optimize-glb.mjs anim    <in.glb> <out.glb>  # keep skeleton + clips only
     bun tools/optimize-glb.mjs inspect <in.glb>            # list bones/clips/textures

   Full models go through the stock CLI instead:
     bunx gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress webp --texture-size 1024

   Animation GLBs from Meshy re-ship the whole skinned mesh + textures; the
   game only reads gltf.animations from them, so everything else is dead
   weight on the wire. `anim` mode deletes meshes/skins/materials/textures
   and prunes — leaving the bone hierarchy the clips animate.
*/
import { writeFile } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, resample, quantize } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [mode, input, output] = process.argv.slice(2);
if (!mode || !input) {
  console.error('usage: optimize-glb.mjs <anim|inspect> <in.glb> [out.glb]');
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(input);
const root = doc.getRoot();

if (mode === 'inspect') {
  console.log('meshes:', root.listMeshes().map((m) => `${m.getName()}(${m.listPrimitives().length})`).join(' '));
  console.log('skins:', root.listSkins().map((s) => `${s.getName()}(${s.listJoints().length} joints)`).join(' '));
  for (const s of root.listSkins()) console.log('joints:', s.listJoints().map((j) => j.getName()).join(' '));
  console.log(
    'animations:',
    root.listAnimations().map((a) => `${a.getName()}(${a.listChannels().length}ch)`).join(' '),
  );
  console.log(
    'textures:',
    root.listTextures().map((t) => `${t.getMimeType()} ${((t.getImage()?.byteLength ?? 0) / 1024) | 0}KiB`).join(' '),
  );
  console.log('nodes:', root.listNodes().length);
  process.exit(0);
}

if (mode === 'anim') {
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  for (const mat of root.listMaterials()) mat.dispose();
  for (const tex of root.listTextures()) tex.dispose();
  await doc.transform(resample(), dedup(), prune({ keepLeaves: true }), quantize());
  const glb = await io.writeBinary(doc);
  await writeFile(output, glb);
  console.log(`${output}: ${(glb.byteLength / 1024).toFixed(0)} KiB`);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(1);
}
