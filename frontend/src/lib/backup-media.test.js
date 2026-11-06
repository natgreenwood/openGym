import { describe, it, expect } from 'vitest'
import { exportBackupZip, readBackupFile, backupImportError, storeBackupMedia, undoBackupMedia, sanitizeCustomMedia, BACKUP_JSON } from './backup-media.js'
import { createMediaStore, memoryBackend } from './media-store.js'
import { zipStore, readZip } from './zip.js'
import { sha256Hex } from './sha256.js'
import { jpeg, png, mp4 } from './media-samples.test-util.js'
import { workoutMediaOf } from './media-refs.js'

const refFor = async (bytes, mime, kind = 'image') => ({ kind, hash: await sha256Hex(bytes), mime, size: bytes.length, width: 4, height: 3, at: 1 })
const stateWith = customEx => ({ unit: 'kg', workouts: [], routines: [], bodyweight: [], customEx })

describe('export with photos & videos', () => {
  it('writes the same JSON, every file the state refers to under its hash, and a README; counts what it could not get', async () => {
    const media = createMediaStore(memoryBackend())
    const photo = jpeg(), poster = png(), clip = mp4().file
    const main = await refFor(photo, 'image/jpeg')
    const vid = await refFor(clip, 'video/quicktime', 'video')
    main.poster = { hash: await sha256Hex(poster), mime: 'image/webp', size: poster.length, width: 2, height: 2 }
    await media.put(main.hash, new Blob([photo]), { mime: 'image/jpeg' })
    await media.put(main.poster.hash, new Blob([poster]), { mime: 'image/png' })
    await media.put(vid.hash, new Blob([clip]), { mime: 'video/quicktime' })
    const gone = { ...main, hash: 'f'.repeat(64), poster: undefined }
    const S = stateWith([{ id: 'a', n: 'a', media: main }, { id: 'b', n: 'b', media: vid }, { id: 'c', n: 'c', media: gone }])
    const fetched = []
    const out = await exportBackupZip(S, { media, fetchOne: async h => { fetched.push(h); throw new Error('404') } })
    expect(out.missing).toBe(1)
    expect(out.included).toBe(3)
    expect(fetched).toEqual(['f'.repeat(64)])
    const entries = await readZip(out.blob)
    expect(entries.map(e => e.name)).toEqual([BACKUP_JSON, `media/${main.poster.hash}.png`, `media/${main.hash}.jpg`, `media/${vid.hash}.mov`, 'README.txt'])
    expect(JSON.parse(await entries[0].blob.text())).toEqual(JSON.parse(JSON.stringify(S, null, 2)))
  })

  it('only exports archives the import path accepts at the entry limit', async () => {
    const media = createMediaStore(memoryBackend())
    const S = stateWith([])
    for (let i = 1; i <= 1999; i++) {
      const bytes = png(i, 1)
      const hash = await sha256Hex(bytes)
      await media.put(hash, new Blob([bytes]), { mime: 'image/png' })
      S.customEx.push({ id: `e${i}`, media: { kind: 'image', hash, mime: 'image/png', size: bytes.length, width: i, height: 1, at: 1 } })
      if (i === 1998) {
        const out = await exportBackupZip(S, { media })
        expect(out).toMatchObject({ included: 1998, missing: 0 })
        expect((await readBackupFile(new File([out.blob], 'backup.zip'))).files).toHaveLength(1998)
      }
    }
    await expect(exportBackupZip(S, { media })).rejects.toMatchObject({ code: 'too-many' })
  })
})

describe('import', () => {
  it('a zip brings its state and, once stored, its files as pending', async () => {
    const photo = jpeg()
    const main = await refFor(photo, 'image/jpeg')
    const S = stateWith([{ id: 'a', n: 'a', media: main, url: 'youtu.be/x' }])
    const zip = await zipStore([{ name: BACKUP_JSON, blob: new Blob([JSON.stringify(S)]) }, { name: `media/${main.hash}.jpg`, blob: new Blob([photo]) }, { name: 'media/' + 'e'.repeat(64) + '.jpg', blob: new Blob([photo]) }])
    const read = await readBackupFile(new File([zip], 'backup.zip'))
    expect(read.zip).toBe(true)
    expect(read.state.customEx[0].url).toBe('https://youtu.be/x')
    expect(read.files.map(f => f.hash)).toEqual([main.hash])   // only what the state refers to
    const media = createMediaStore(memoryBackend())
    expect(await storeBackupMedia(read.files, { media })).toEqual({ stored: 1, skipped: 0, added: [main.hash], marked: [] })
    expect(await media.get(main.hash)).toMatchObject({ mime: 'image/jpeg', pending: true })
  })

  it('a tampered file is skipped, and so is one over its cap or of a type that is not stored', async () => {
    const photo = jpeg()
    const main = await refFor(photo, 'image/jpeg')
    const tampered = photo.slice(); tampered[tampered.length - 1] ^= 1
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
    const htmlRef = { ...main, hash: await sha256Hex(html) }
    const big = new Uint8Array(3 * 1024 * 1024); big.set(photo)
    const bigRef = { ...main, hash: await sha256Hex(big), size: big.length }
    const S = stateWith([{ id: 'a', media: main }, { id: 'b', media: htmlRef }, { id: 'c', media: bigRef }])
    const zip = await zipStore([
      { name: BACKUP_JSON, blob: new Blob([JSON.stringify(S)]) },
      { name: `media/${main.hash}.jpg`, blob: new Blob([tampered]) },
      { name: `media/${htmlRef.hash}.jpg`, blob: new Blob([html]) },
      { name: `media/${bigRef.hash}.jpg`, blob: new Blob([big]) }
    ])
    const read = await readBackupFile(new File([zip], 'b.zip'))
    const media = createMediaStore(memoryBackend())
    expect(await storeBackupMedia(read.files, { media })).toEqual({ stored: 0, skipped: 3, added: [], marked: [] })
    expect(await media.list()).toEqual([])
  })

  it('a JSON backup reads as before, with its refs and links through the same gates', async () => {
    const S = stateWith([{ id: 'a', media: { kind: 'image', hash: 'nope' }, url: 'javascript:alert(1)' }, { id: 'b', media: await refFor(jpeg(), 'image/jpeg') }])
    const read = await readBackupFile(new File([JSON.stringify(S)], 'b.json', { type: 'application/json' }))
    expect(read.zip).toBe(false)
    expect(read.files).toEqual([])
    expect(read.state.customEx[0]).toEqual({ id: 'a' })
    expect(read.state.customEx[1].media.mime).toBe('image/jpeg')
  })

  it('refuses what is not an openGym backup, zipped or not', async () => {
    await expect(readBackupFile(new File(['{"hello":1}'], 'x.json'))).rejects.toThrow()
    const zip = await zipStore([{ name: 'something.txt', blob: new Blob(['x']) }])
    await expect(readBackupFile(new File([zip], 'x.zip'))).rejects.toThrow()
  })

  // German QA: 'Import fehlgeschlagen: not-zip', '... not an openGym backup', 'Unexpected token ...'.
  it('says why an import failed in words, never the thrown developer text', async () => {
    const why = async (content, name) => { try { await readBackupFile(new File([content], name)) } catch (e) { return backupImportError(e) } }
    const notOurs = 'That file isn’t an openGym backup.'
    expect(await why('[1,2]', 'x.json')).toBe(notOurs)
    expect(await why('hello there', 'x.txt')).toBe(notOurs)
    expect(await why(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), 'fake.zip')).toBe(notOurs)
    expect(await why(await zipStore([{ name: 'something.txt', blob: new Blob(['x']) }]), 'x.zip')).toBe(notOurs)
    expect(backupImportError(Object.assign(new Error('compressed'), { code: 'compressed' }))).toBe('That zip was repacked. Import the original backup file.')
    expect(backupImportError(new TypeError('x is undefined'))).toBe('Couldn’t read that file.')
  })

  it('sanitizeCustomMedia leaves a state without custom exercises alone', () => {
    expect(sanitizeCustomMedia({ workouts: [] })).toEqual({ workouts: [] })
  })

  it('a workout\'s photos and videos come in through the same gates: bad refs dropped, one per file — past the cap kept, shown up to six', () => {
    const ok = n => ({ kind: 'image', hash: String(n).repeat(64), mime: 'image/webp', size: 10, width: 4, height: 3, at: 1 })
    const S = { workouts: [
      { id: 'w1', media: [ok(1), { ...ok(2), mime: 'text/html' }, ok(1), ok(3), ok(4), ok(5), ok(6), ok(7), ok(8)] },
      { id: 'w2', media: 'x' },
      { id: 'w3' }
    ] }
    sanitizeCustomMedia(S)
    expect(S.workouts[0].media.map(m => m.hash[0])).toEqual(['1', '3', '4', '5', '6', '7', '8'])
    expect(workoutMediaOf(S.workouts[0]).map(m => m.hash[0])).toEqual(['1', '3', '4', '5', '6', '7'])
    expect('media' in S.workouts[1]).toBe(false)
    expect(S.workouts[2]).toEqual({ id: 'w3' })
  })
})

describe('a workout\'s photos and videos in the zip', () => {
  it('are exported next to the exercises\' and come back in from the zip', async () => {
    const media = createMediaStore(memoryBackend())
    const photo = jpeg(), clip = mp4().file
    const p = await refFor(photo, 'image/jpeg')
    const v = await refFor(clip, 'video/mp4', 'video')
    await media.put(p.hash, new Blob([photo]), { mime: 'image/jpeg' })
    await media.put(v.hash, new Blob([clip]), { mime: 'video/mp4' })
    const S = { ...stateWith([]), workouts: [{ id: 'w1', d: '2026-09-20', start: 1, end: 2, entries: [], media: [p, v] }] }
    const out = await exportBackupZip(S, { media })
    expect(out).toMatchObject({ included: 2, missing: 0 })
    const read = await readBackupFile(new File([out.blob], 'backup.zip'))
    expect(read.state.workouts[0].media).toEqual([p, v])
    expect(read.files.map(f => f.hash).sort()).toEqual([p.hash, v.hash].sort())
    const into = createMediaStore(memoryBackend())
    expect(await storeBackupMedia(read.files, { media: into })).toMatchObject({ stored: 2, skipped: 0, marked: [] })
    expect(await into.get(v.hash)).toMatchObject({ mime: 'video/mp4', pending: true })
  })
})

// NATG-557: an import refused once its files are written (the account changed meanwhile) takes
// back what it wrote, and only that. What was here before the import stays as it was.
describe('a refused import\'s files', () => {
  const records = async media => (await media.list())
    .map(({ hash, pending, rejected }) => ({ hash, pending, rejected }))
    .sort((a, b) => a.hash.localeCompare(b.hash))

  async function setUp() {
    const media = createMediaStore(memoryBackend())
    const synced = jpeg(), owed = png(), fresh = png(3, 2), other = png(5, 1)
    const refs = {
      synced: await refFor(synced, 'image/jpeg'), owed: await refFor(owed, 'image/png'),
      fresh: await refFor(fresh, 'image/png'), other: await refFor(other, 'image/png'),
    }
    // Already here: one on the server, one still owed to it, one the backup does not carry.
    await media.put(refs.synced.hash, new Blob([synced]), { mime: 'image/jpeg', pending: false })
    await media.put(refs.owed.hash, new Blob([owed]), { mime: 'image/png', pending: true })
    await media.put(refs.other.hash, new Blob([other]), { mime: 'image/png', pending: false })
    const S = stateWith([{ id: 'a', media: refs.synced }, { id: 'b', media: refs.owed }, { id: 'c', media: refs.fresh }])
    const zip = await zipStore([
      { name: BACKUP_JSON, blob: new Blob([JSON.stringify(S)]) },
      { name: `media/${refs.synced.hash}.jpg`, blob: new Blob([synced]) },
      { name: `media/${refs.owed.hash}.png`, blob: new Blob([owed]) },
      { name: `media/${refs.fresh.hash}.png`, blob: new Blob([fresh]) },
    ])
    const read = await readBackupFile(new File([zip], 'backup.zip'))
    return { media, refs, read }
  }

  it('storeBackupMedia says which files it added and which synced ones it marked pending again', async () => {
    const { media, refs, read } = await setUp()
    expect(await storeBackupMedia(read.files, { media })).toEqual({ stored: 3, skipped: 0, added: [refs.fresh.hash], marked: [refs.synced.hash] })
  })

  it('undoBackupMedia leaves the store as it was before the import: new files gone, files already here kept as they were', async () => {
    const { media, read } = await setUp()
    const before = await records(media)
    const kept = await storeBackupMedia(read.files, { media })
    await undoBackupMedia(kept, stateWith([]), { media })
    expect(await records(media)).toEqual(before)
  })

  it('keeps a file it added that the state now in the store refers to, or that an open editor holds', async () => {
    const { media, refs, read } = await setUp()
    const kept = await storeBackupMedia(read.files, { media })
    await undoBackupMedia(kept, stateWith([{ id: 'x', media: refs.fresh }]), { media })
    expect(await media.get(refs.fresh.hash)).toMatchObject({ pending: true })

    const { media: m2, refs: r2, read: read2 } = await setUp()
    const kept2 = await storeBackupMedia(read2.files, { media: m2 })
    const release = m2.hold([r2.fresh.hash])
    await undoBackupMedia(kept2, stateWith([]), { media: m2 })
    release()
    expect(await m2.has(r2.fresh.hash)).toBe(true)
  })
})
