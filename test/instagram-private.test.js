import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { listPrivateHighlights, listPrivatePosts, listPrivateStories } from '../src/platforms/instagramPrivate.js';
import {
  listInstagramCreatorHighlights, listInstagramCreatorPosts, listInstagramCreatorStories,
  probeGalleryDlPost,
  recordPrivateListingOutcome, resetPrivateListingBreakerForTests, shouldSkipPrivateListings,
} from '../src/platforms/galleryDl.js';

const INSTAGRAM_THROTTLE_MESSAGE = 'feedback_required: We limit how often you can do certain things on Instagram to protect our community.';

test('Instagram device file strips legacy and newly returned session credentials', async t => {
  if (spawnSync('python3', ['--version']).error?.code === 'ENOENT') {
    t.skip('python3 is not available');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ig-device-privacy-'));
  const deviceFile = path.join(dir, 'device.json');
  const script = new URL('../scripts/instagram-private-list.py', import.meta.url).pathname;
  try {
    const result = spawnSync('python3', ['-c', `
import json, runpy, sys
helper = runpy.run_path(sys.argv[1])
device_file = sys.argv[2]
settings = {
    "uuids": {"uuid": "stable-device"},
    "device_settings": {"model": "Pixel 6"},
    "cookies": {"sessionid": "synthetic-secret"},
    "authorization_data": {"sessionid": "synthetic-secret"},
}
with open(device_file, "w") as file:
    json.dump(settings, file)
loaded = helper["ensure_device_settings"](device_file)
assert set(loaded) == {"uuids", "device_settings"}
assert json.load(open(device_file)) == loaded
helper["save_device_settings"](device_file, settings)
assert json.load(open(device_file)) == loaded
`, script, deviceFile], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('private listings only reuse a matching profile resolved during this poll', async () => {
  const resolvedProfile = { platform: 'instagram', username: 'Creator', creatorId: '123' };
  for (const list of [listPrivatePosts, listPrivateStories, listPrivateHighlights]) {
    for (const [profile, expectedId] of [
      [resolvedProfile, '123'],
      [{ ...resolvedProfile, creatorId: '9007199254740993' }, '9007199254740993'],
      [undefined, ''],
      [{ ...resolvedProfile, platform: 'tiktok' }, ''],
      [{ ...resolvedProfile, username: 'other' }, ''],
      [{ ...resolvedProfile, creatorId: 'not-an-id' }, ''],
      [{ ...resolvedProfile, creatorId: '0' }, ''],
      [{ ...resolvedProfile, creatorId: 123 }, ''],
    ]) {
      let passedId;
      await list('creator', {
        resolvedProfile: profile,
        watch: { platform: 'instagram', username: 'creator', creator_id: '456' },
        spawnImpl: fakeSpawn((executable, args) => {
          const index = args.indexOf('--user-id');
          passedId = index < 0 ? '' : args[index + 1];
          return { stdout: JSON.stringify({ entries: [], metadata: {} }) };
        }),
      });
      assert.equal(passedId, expectedId);
    }
  }
});

test('the Python helper reuses the resolved creator ID but still validates the session for every listing', async t => {
  if (spawnSync('python3', ['--version']).error?.code === 'ENOENT') {
    t.skip('python3 is not available');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ig-private-identity-'));
  const cookies = path.join(dir, 'cookies.txt');
  await writeFile(cookies, '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tfixture\n');
  const script = new URL('../scripts/instagram-private-list.py', import.meta.url).pathname;
  try {
    for (const listing of ['posts', 'stories', 'highlights']) {
      for (const userId of ['', '123', '9007199254740993', 'invalid', '0']) {
        const result = spawnSync('python3', ['-c', `
import runpy, sys, types
calls = []
class Client:
    def __init__(self, settings): self.settings = settings
    def get_settings(self): return self.settings
    def login_by_sessionid(self, session): calls.append("login")
    def user_info_by_username_v1(self, handle):
        calls.append("lookup")
        return types.SimpleNamespace(pk="456")
    def listing(self, user_id, amount=None):
        calls.append("list:" + user_id)
        return []
    user_medias_v1 = user_stories_v1 = user_highlights = listing
module = types.ModuleType("instagrapi")
module.Client = Client
sys.modules["instagrapi"] = module
sys.argv = ${JSON.stringify([script, '--handle', 'creator', '--type', listing, '--cookies', cookies, '--device-file', path.join(dir, 'device.json'), ...(userId ? ['--user-id', userId] : [])])}
try:
    runpy.run_path(${JSON.stringify(script)}, run_name="__main__")
finally:
    print(calls, file=sys.stderr)
`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
        if (['invalid', '0'].includes(userId)) {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /\[\]/);
        } else {
          assert.equal(result.status, 0, result.stderr);
          const expectedId = userId || '456';
          assert.equal(JSON.parse(result.stdout).metadata.creator_id, expectedId);
          assert.equal(result.stderr.trim(), userId
            ? `['login', 'list:${expectedId}']`
            : `['login', 'lookup', 'list:${expectedId}']`);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const code of [0, 1]) {
  test(`private helper preserves validated failure stages on exit ${code}`, async () => {
    for (const stage of ['login', 'lookup', 'posts', 'stories', 'highlights', 'untrusted-value']) {
      await assert.rejects(listPrivatePosts('creator', {
        spawnImpl: fakeSpawn(() => ({
          code, stdout: JSON.stringify({ error: 'Not authorized to view user', stage }),
        })),
      }), error => {
        assert.equal(error.kind, 'access_denied');
        assert.equal(error.stage, stage === 'untrusted-value' ? '' : stage);
        return true;
      });
    }
  });
}

test('one inaccessible Instagram creator does not divert another creator to gallery-dl', async () => {
  resetPrivateListingBreakerForTests();
  const calls = [];
  const options = {
    spawnImpl: fakeSpawn((executable, args) => {
      calls.push(executable);
      if (executable !== 'python3') {
        return { code: 1, stderr: 'Unexpected HTTP 467 at https://example.test/?token=sentinel' };
      }
      const handle = args[args.indexOf('--handle') + 1];
      return handle === 'denied'
        ? { code: 1, stdout: JSON.stringify({ error: 'Not authorized to view user', stage: 'posts' }) }
        : { stdout: JSON.stringify({ entries: [], metadata: { uploader: handle } }) };
    }),
  };
  try {
    let failure;
    await assert.rejects(listInstagramCreatorPosts('denied', options), error => {
      failure = error;
      assert.equal(error.kind, 'gallery_dl_error');
      return true;
    });
    assert.equal(shouldSkipPrivateListings(), false);
    assert.match(failure.message, /Private API: access_denied \(posts\)/);
    assert.doesNotMatch(failure.message, /token|sentinel|https:\/\//);
    const result = await listInstagramCreatorPosts('allowed', options);
    assert.equal(result.metadata.uploader, 'allowed');
    assert.deepEqual(calls, ['python3', 'gallery-dl', 'python3']);
  } finally {
    resetPrivateListingBreakerForTests();
  }
});

test('an Instagram login denial still prevents repeated account-wide logins', async () => {
  resetPrivateListingBreakerForTests();
  const calls = [];
  const options = {
    spawnImpl: fakeSpawn(executable => {
      calls.push(executable);
      return executable === 'python3'
        ? { code: 1, stdout: JSON.stringify({ error: 'Login challenged', stage: 'login' }) }
        : { code: 1, stderr: 'Unexpected HTTP 467' };
    }),
  };
  try {
    await assert.rejects(listInstagramCreatorPosts('first', options));
    assert.equal(shouldSkipPrivateListings(), true);
    await assert.rejects(listInstagramCreatorPosts('second', options));
    assert.deepEqual(calls, ['python3']);
  } finally {
    resetPrivateListingBreakerForTests();
  }
});

test('Instagram action throttles pause all listing transports without extending the deadline on local retries', async t => {
  resetPrivateListingBreakerForTests();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const options = {
    spawnImpl: fakeSpawn(executable => {
      calls.push(executable);
      return calls.length === 1
        ? { code: 1, stdout: JSON.stringify({ error: INSTAGRAM_THROTTLE_MESSAGE, stage: 'posts' }) }
        : { stdout: JSON.stringify({ entries: [], metadata: { uploader: 'creator' } }) };
    }),
  };
  const isThrottled = error => {
    assert.equal(error.kind, 'rate_limited');
    assert.equal(error.retryable, true);
    return true;
  };
  try {
    await assert.rejects(listInstagramCreatorPosts('first', options), isThrottled);
    assert.equal(shouldSkipPrivateListings(now), true);
    assert.deepEqual(calls, ['python3']);

    now += 10 * 60 * 1000;
    for (const list of [listInstagramCreatorPosts, listInstagramCreatorStories, listInstagramCreatorHighlights]) {
      await assert.rejects(list('another', options), isThrottled);
    }
    // An already-running successful request must not reopen a throttled account.
    recordPrivateListingOutcome(null, now);
    await assert.rejects(listInstagramCreatorPosts('another', options), isThrottled);
    assert.deepEqual(calls, ['python3']);

    now = 1000 + 6 * 60 * 60 * 1000;
    assert.equal(shouldSkipPrivateListings(now), false);
    const result = await listInstagramCreatorPosts('creator', options);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(calls, ['python3', 'python3']);
  } finally {
    resetPrivateListingBreakerForTests();
  }
});

test('generic feedback messages are not assumed to be rate limits', async () => {
  await assert.rejects(listPrivatePosts('creator', {
    spawnImpl: fakeSpawn(() => ({
      code: 1, stdout: JSON.stringify({ error: 'feedback_required: Please review your account.', stage: 'posts' }),
    })),
  }), error => {
    assert.notEqual(error.kind, 'rate_limited');
    return true;
  });
});

test('the Python helper reports failure stages and never turns a failed story fetch into an empty list', async t => {
  if (spawnSync('python3', ['--version']).error?.code === 'ENOENT') {
    t.skip('python3 is not available');
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ig-private-errors-'));
  const cookies = path.join(dir, 'cookies.txt');
  await writeFile(cookies, '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tfixture\n');
  const script = new URL('../scripts/instagram-private-list.py', import.meta.url).pathname;
  try {
    const cases = ['login', 'lookup', 'posts', 'stories', 'highlights', 'empty']
      .flatMap(stage => (stage === 'lookup' ? [''] : ['', '123']).map(userId => ({ stage, userId })));
    for (const { stage, userId } of cases) {
      const listing = ['stories', 'highlights', 'empty'].includes(stage) ? (stage === 'empty' ? 'stories' : stage) : 'posts';
      const result = spawnSync('python3', ['-c', `
import runpy, sys, types
stage = ${JSON.stringify(stage)}
def operation(name, value=None):
    if stage == name:
        raise RuntimeError("Not authorized to view user")
    return value
class Client:
    def __init__(self, settings): self.settings = settings
    def get_settings(self): return self.settings
    def login_by_sessionid(self, session):
        if stage == "login":
            self.handle_exception(self, RuntimeError("Not authorized to view user"))
            raise AssertionError("The account exception handler must stop the request")
        return operation("login")
    def user_info_by_username_v1(self, handle): return operation("lookup", types.SimpleNamespace(pk="123"))
    def user_medias_v1(self, user_id, amount): return operation("posts", [])
    def user_stories_v1(self, user_id, amount): return operation("stories", [])
    def user_highlights(self, user_id): return operation("highlights", [])
module = types.ModuleType("instagrapi")
module.Client = Client
sys.modules["instagrapi"] = module
exceptions = types.ModuleType("instagrapi.exceptions")
exceptions.ClientError = RuntimeError
sys.modules["instagrapi.exceptions"] = exceptions
sys.argv = ${JSON.stringify([script, '--handle', 'creator', '--type', listing, '--cookies', cookies, '--device-file', path.join(dir, 'device.json'), ...(userId ? ['--user-id', userId] : [])])}
runpy.run_path(${JSON.stringify(script)}, run_name="__main__")
`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      assert.equal(result.status, stage === 'empty' ? 0 : 1, `${stage}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      if (stage === 'empty') assert.deepEqual(output.entries, []);
      else {
        assert.equal(output.stage, stage);
        assert.match(output.error, /Not authorized to view user/);
        assert.equal(output.entries, undefined);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeSpawn(resultForCall) {
  return (executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      const result = resultForCall(executable, args);
      child.stdout.end(result.stdout || '');
      child.stderr.end(result.stderr || '');
      child.emit('close', result.code || 0, null);
    });
    return child;
  };
}

test('Instagram cooldown survives process-state reset and gallery fallback throttles stop subsequent calls', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'instagram-cooldown-test-'));
  resetPrivateListingBreakerForTests();
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const options = { dataDir, spawnImpl: fakeSpawn(executable => {
    calls.push(executable);
    return executable === 'python3'
      ? { code: 1, stdout: JSON.stringify({ error: 'Malformed media', stage: 'posts' }) }
      : { code: 1, stderr: '429 Too many requests' };
  }) };
  try {
    await assert.rejects(listInstagramCreatorPosts('creator', options), error => {
      assert.equal(error.kind, 'rate_limited');
      assert.equal(error.retryAt, 1000 + 6 * 60 * 60 * 1000);
      return true;
    });
    assert.deepEqual(calls, ['python3', 'gallery-dl']);
    resetPrivateListingBreakerForTests();
    now += 60_000;
    await assert.rejects(listInstagramCreatorStories('another', options), error => {
      assert.equal(error.kind, 'rate_limited');
      assert.equal(error.retryAt, 1000 + 6 * 60 * 60 * 1000);
      return true;
    });
    assert.deepEqual(calls, ['python3', 'gallery-dl']);
  } finally {
    resetPrivateListingBreakerForTests();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('direct Instagram extraction restrictions pause listings and subsequent download probes', async t => {
  resetPrivateListingBreakerForTests();
  t.mock.method(Date, 'now', () => 1000);
  let calls = 0;
  const options = { spawnImpl: fakeSpawn(() => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify([[-1, { message: 'challenge_required' }]]) };
  }) };
  const post = { platform: 'instagram', remoteId: 'AbCd', canonicalUrl: 'https://www.instagram.com/p/AbCd/' };
  try {
    await assert.rejects(probeGalleryDlPost(post, options), error => error.retryAt === 1000 + 24 * 60 * 60_000);
    await assert.rejects(listInstagramCreatorPosts('another', options), /requests are paused/);
    await assert.rejects(probeGalleryDlPost(post, options), /requests are paused/);
    assert.equal(calls, 1);
  } finally { resetPrivateListingBreakerForTests(); }
});
