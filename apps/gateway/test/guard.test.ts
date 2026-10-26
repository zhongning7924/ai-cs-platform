import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adminGuard,
  createRateLimiter,
  originGuard,
  parseOrigins,
} from '../src/guard.js';

/** 最小 req/res 桩：只实现中间件真正用到的成员，不引 supertest。 */
function req(over: Record<string, unknown> = {}) {
  const r = {
    ip: '10.0.0.5',
    socket: { remoteAddress: '10.0.0.5' },
    headers: {} as Record<string, string>,
    query: {} as Record<string, string>,
    header(name: string) {
      return this.headers[name.toLowerCase()];
    },
    ...over,
  };
  return r as unknown as Parameters<ReturnType<typeof adminGuard>>[0];
}

function res() {
  const r = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    json(payload: unknown) {
      r.body = payload;
      return r;
    },
    setHeader(key: string, value: string) {
      r.headers[key] = value;
    },
  };
  return r as unknown as Parameters<ReturnType<typeof adminGuard>>[1] & typeof r;
}

/** 跑一次中间件，返回 next 是否被调用。 */
function run(mw: ReturnType<typeof adminGuard>, r: ReturnType<typeof req>, s: ReturnType<typeof res>) {
  let called = false;
  mw(r, s, () => {
    called = true;
  });
  return called;
}

test('adminGuard：未配 token 时只放本机，外部一律 403', () => {
  const guard = adminGuard(undefined);

  const local = req({ ip: '127.0.0.1' });
  assert.equal(run(guard, local, res()), true);

  const remote = req({ ip: '192.168.1.20' });
  const remoteRes = res();
  assert.equal(run(guard, remote, remoteRes), false);
  assert.equal(remoteRes.statusCode, 403);
  assert.equal((remoteRes.body as { error: string }).error, 'admin_token_unset');
});

test('adminGuard：配了 token 后校验 header，错 token 401', () => {
  const guard = adminGuard('s3cret');

  assert.equal(run(guard, req({ headers: { 'x-admin-token': 's3cret' } }), res()), true);
  assert.equal(run(guard, req({ query: { token: 's3cret' } }), res()), true);

  const bad = res();
  assert.equal(run(guard, req({ headers: { 'x-admin-token': 'wrong' } }), bad), false);
  assert.equal(bad.statusCode, 401);

  // 长度不同的 token 也要挡住（safeEqual 前置判断）
  const short = res();
  assert.equal(run(guard, req({ headers: { 'x-admin-token': 's3' } }), short), false);
  assert.equal(short.statusCode, 401);
});

test('originGuard：未配置白名单时不校验', () => {
  assert.equal(run(originGuard([]), req(), res()), true);
});

test('originGuard：命中 Origin 放行，Referer 可兜底', () => {
  const guard = originGuard(['https://shop.example.com']);

  assert.equal(
    run(guard, req({ headers: { origin: 'https://shop.example.com' } }), res()),
    true,
  );
  // 路径型 Referer 只取 origin 部分比对
  assert.equal(
    run(guard, req({ headers: { referer: 'https://shop.example.com/p/123?x=1' } }), res()),
    true,
  );

  const denied = res();
  assert.equal(
    run(guard, req({ headers: { origin: 'https://evil.example.com' } }), denied),
    false,
  );
  assert.equal(denied.statusCode, 403);
  assert.equal((denied.body as { error: string }).error, 'origin_denied');
});

test('originGuard：配了白名单但请求不带来源，拒绝', () => {
  const r = res();
  assert.equal(run(originGuard(['https://shop.example.com']), req(), r), false);
  assert.equal((r.body as { error: string }).error, 'origin_required');
});

test('parseOrigins：去空白、去尾斜杠、丢空项', () => {
  assert.deepEqual(parseOrigins(' https://a.com/ , https://b.com ,, '), [
    'https://a.com',
    'https://b.com',
  ]);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('rateLimit：第 N+1 次 429，窗口滑过后恢复', () => {
  let now = 1_000_000;
  const mw = createRateLimiter(3, () => now);
  const r = () => req({ ip: '10.0.0.9' });

  assert.equal(run(mw, r(), res()), true);
  assert.equal(run(mw, r(), res()), true);
  assert.equal(run(mw, r(), res()), true);

  const blocked = res();
  assert.equal(run(mw, r(), blocked), false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');

  // 另一 IP 不受影响
  assert.equal(run(mw, req({ ip: '10.0.0.10' }), res()), true);

  // 61 秒后窗口滑过，恢复
  now += 61_000;
  assert.equal(run(mw, r(), res()), true);
});

test('rateLimit：limit<=0 视为关闭', () => {
  const mw = createRateLimiter(0);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(run(mw, req(), res()), true);
  }
});
