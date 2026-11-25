// Retrofit requests in Java and Kotlin: read as calls, matched to the project's own routes when it has them,
// and otherwise listed on an http edge to the outside service they go to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, run, readJson, readGraph, writeJson, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const calls = (src, lang) => extract(src, lang, 'X.' + (lang === 'java' ? 'java' : 'kt')).calls.map((c) => `${c.method} ${c.path}`).sort();
const outs = (root) => readGraph(root).links.filter((l) => l.out).map((l) => `${l.a.split('/').pop()} -> ${l.b} ${l.out.map(([m, p, f]) => `${m} ${p} ${f.split('/').pop()}`).join(',')}`);

test('Retrofit: each verb, @HTTP, value =, a leading slash, and a full URL', () => {
  const r = extract([
    'package com.example.api;',
    '',
    'import retrofit2.Call;',
    'import retrofit2.http.*;',
    '',
    'public interface MusicService {',
    '    @GET("getAlbum")',
    '    Call<Album> getAlbum(@Query("id") String id);',
    '    @POST(value = "playlists/{id}/songs")',
    '    Call<Void> addSong(@Path("id") String id);',
    '    @DELETE("/v2/playlists/{id}")',
    '    Call<Void> delete(@Path("id") String id);',
    '    @HTTP(method = "PATCH", path = "playlists/{id}", hasBody = true)',
    '    Call<Void> rename(@Path("id") String id);',
    '    @GET("https://api.github.com/repos/{owner}/{repo}/releases/latest")',
    '    Call<Release> latest(@Path("owner") String owner, @Path("repo") String repo);',
    '    @GET("http://localhost:8080/debug/state")',
    '    Call<State> debugState();',
    '    // @GET("oldEndpoint")',
    '    @GET',
    '    Call<Page> next(@Url String url);',
    '}',
  ].join('\n'), 'java', 'MusicService.java');
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path} @${c.line}`).sort(), [
    'DELETE /v2/playlists/{id} @11',
    'GET /repos/{owner}/{repo}/releases/latest @15',
    'GET getAlbum @7',
    'PATCH playlists/{id} @13',
    'POST playlists/{id}/songs @9',
  ]);
  assert.deepEqual(r.calls.filter((c) => c.host).map((c) => `${c.path} ${c.host}`), ['/repos/{owner}/{repo}/releases/latest api.github.com']);
  // a local address, as in a debug build, is not an outside service
  assert.deepEqual(r.hosts.map((h) => h.host), ['api.github.com']);
});

test('Retrofit: paths the call reader would take for file names or wordless strings are still requests', () => {
  const src = (paths) => ['package com.example.api', '', 'import retrofit2.http.*', '', 'interface S {', ...paths.flatMap((x, i) => [`    @GET("${x}")`, `    suspend fun f${i}(): Response`]), '    @HTTP(method = "delete", path = "users/{id}")', '    suspend fun remove(): Response', '}'].join('\n');
  assert.deepEqual(calls(src(['v1/forecast.json', 'rss/feed.xml', 'users/{id}.json', 'v1', 'v2/{id}', '{username}', '/v1/forecast.json', 'search?q=x', '.', '']), 'kotlin'), [
    'DELETE users/{id}', 'GET /v1/forecast.json', 'GET rss/feed.xml', 'GET search', 'GET users/{id}.json', 'GET v1', 'GET v1/forecast.json', 'GET v2/{id}', 'GET {username}',
  ]);
});

test('Retrofit in Kotlin, and the same annotations without a Retrofit import are not calls', () => {
  assert.deepEqual(calls([
    'package com.example.api',
    '',
    'import retrofit2.http.GET',
    'import retrofit2.http.Query',
    '',
    'interface SearchService {',
    '    @GET("search3")',
    '    suspend fun search(@Query("query") query: String): SearchResult',
    '}',
  ].join('\n'), 'kotlin'), ['GET search3']);
  assert.deepEqual(calls('package com.example\n\nimport com.other.http.GET\n\ninterface Other {\n    @GET("users")\n    fun users(): List<User>\n}\n', 'kotlin'), []);
  // naming Retrofit in a string is not importing it
  assert.deepEqual(calls('package com.example\n\nimport com.other.http.GET\n\nval hint = "import retrofit2.http.GET"\n\ninterface Other {\n    @GET("users")\n    fun users(): List<User>\n}\n', 'kotlin'), []);
});

const M = 'app/src/main/java/com/example/app/';
const files = {
  [M + 'api/BrowsingService.java']: [
    'package com.example.app.api;',
    '',
    'import retrofit2.Call;',
    'import retrofit2.http.GET;',
    '',
    'public interface BrowsingService {',
    '    @GET("getAlbum")',
    '    Call<Album> getAlbum(String id);',
    '    @GET("getArtist")',
    '    Call<Artist> getArtist(String id);',
    '}',
  ].join('\n'),
  [M + 'api/SystemService.kt']: [
    'package com.example.app.api',
    '',
    'import retrofit2.http.GET',
    '',
    'interface SystemService {',
    '    @GET("ping")',
    '    suspend fun ping(): Response',
    '    @GET("ping")',
    '    suspend fun pingAgain(): Response',
    '}',
  ].join('\n'),
  [M + 'sync/ReportService.kt']: [
    'package com.example.app.sync',
    '',
    'import retrofit2.http.POST',
    '',
    'interface ReportService {',
    '    @POST("api/reports")',
    '    suspend fun send(): Response',
    '}',
  ].join('\n'),
  'server/src/main/java/com/example/server/ReportController.java': [
    'package com.example.server;',
    '',
    'import org.springframework.web.bind.annotation.*;',
    '',
    '@RestController',
    'public class ReportController {',
    '    @PostMapping("/api/reports")',
    '    public void receive() {}',
    '}',
  ].join('\n'),
};
const arch = {
  project: { name: 'Music app' },
  nodes: [
    { id: 'api', label: 'Music server requests', kind: 'library', paths: [M + 'api/**'] },
    { id: 'sync', label: 'Report sync', kind: 'feature', paths: [M + 'sync/**'] },
    { id: 'server', label: 'Report server', kind: 'service', paths: ['server/**'] },
    { id: 'music-server', label: 'Music server', kind: 'external' },
  ],
  edges: [{ from: 'api', to: 'music-server', kind: 'http' }],
};

test('Retrofit calls a route in the project answers link to it; the rest go on the http edge to the outside service', () => {
  const root = makeProject(files, { repos: ['.'], arch });
  try {
    const scanOut = run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(s.http.map((h) => `${h.from.split('/').pop()} -> ${h.to.split('/').pop()} ${h.method} ${h.path}`), ['ReportService.kt -> ReportController.java POST /api/reports']);
    assert.deepEqual(s.unmatchedCalls.map((c) => `${c.from.split('/').pop()} ${c.method} ${c.path}`).sort(), [
      'BrowsingService.java GET getAlbum',
      'BrowsingService.java GET getArtist',
      'SystemService.kt GET ping',
      'SystemService.kt GET ping',
    ]);
    assert.match(scanOut, /RETROFIT REQUESTS NO SCANNED ROUTE ANSWERS {2}4\b/);
    const buildOut = run('build.mjs', root, '--no-claude-md');
    assert.match(buildOut, /OUTSIDE CALLS {2}3 Retrofit requests on http edges to outside services\n {6}3 {2}api → music-server\n/);
    assert.doesNotMatch(buildOut, /secret-looking/);
    const g = readGraph(root);
    const edge = g.links.find((l) => l.a === 'n:api' && l.b === 'n:music-server');
    assert.deepEqual(edge.out.map(([m, p, f]) => `${m} ${p} ${f.split('/').pop()}`).sort(), [
      'GET getAlbum BrowsingService.java',
      'GET getArtist BrowsingService.java',
      'GET ping SystemService.kt',
    ]);
    assert.equal(g.links.filter((l) => l.out).length, 1);
  } finally { cleanup(root); }
});

test('Calls no edge carries are counted in the build report, and an edge from one file carries only that file', () => {
  const root = makeProject(files, { repos: ['.'], arch: { ...arch, edges: [{ from: M + 'api/SystemService.kt', to: 'music-server', kind: 'http' }] } });
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--no-claude-md');
    assert.match(out, /OUTSIDE CALLS {2}1 Retrofit requests on http edges to outside services · 2 more no scanned route answers/);
    const edge = readGraph(root).links.find((l) => l.b === 'n:music-server');
    assert.deepEqual(edge.out.map(([m, p]) => `${m} ${p}`), ['GET ping']);
  } finally { cleanup(root); }
});

test('Only Retrofit requests are listed, a web request beside a service\'s address, a Ktor route and a base URL being built are not, and the address does not take the requests beside it', () => {
  const project = {
    'src/stripe.ts': ["export const STRIPE = 'https://api.stripe.com/v3';", "export const start = () => fetch('/api/checkout-session', { method: 'POST' });"].join('\n'),
    'src/Routes.kt': ['package com.example.server', '', 'import io.ktor.server.routing.*', '', 'fun Route.users() {', '    get("/users") { call.respond(list()) }', '    post("/users") { call.respond(add()) }', '}'].join('\n'),
    'src/Client.java': ['package com.example;', '', 'public class Client {', '    private String getUrl() {', '        String url = preferences.getServerUrl() + "/rest/";', '        return url.replace("//rest", "/rest");', '    }', '}'].join('\n'),
    'src/PayService.kt': ['package com.example', '', 'import retrofit2.http.POST', '', 'interface PayService {', '    @POST("v1/charges")', '    suspend fun charge(): Response', '}'].join('\n'),
  };
  const root = makeProject(project, { repos: ['.'], arch: { project: { name: 'Shop' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', paths: ['src/**'] }, { id: 'stripe', label: 'Stripe', kind: 'external', hosts: ['api.stripe.com'] }], edges: [] } });
  try {
    const scanOut = run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(s.unmatchedCalls.map((c) => `${c.from} ${c.method} ${c.path}`), ['src/PayService.kt POST v1/charges']);
    assert.match(scanOut, /RETROFIT REQUESTS NO SCANNED ROUTE ANSWERS {2}1\b/);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 more no scanned route answers/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('An http edge to a part of the project, not an outside service, carries no outside calls', () => {
  const root = makeProject(files, { repos: ['.'], arch: { ...arch, edges: [{ from: 'api', to: 'server', kind: 'http' }] } });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    assert.equal(readGraph(root).links.filter((l) => l.out).length, 0);
  } finally { cleanup(root); }
  const ownHost = makeProject({ ...files, [M + 'api/Base.java']: ['package com.example.app.api;', '', 'import retrofit2.http.GET;', '', 'public class Base {', '    public String getUrl() {', '        return "https://reports.musicapp.io/";', '    }', '    interface Status {', '        @GET("status")', '        Call<Object> status();', '    }', '}'].join('\n') },
    { repos: ['.'], arch: { ...arch, nodes: arch.nodes.map((n) => (n.id === 'server' ? { ...n, hosts: ['reports.musicapp.io'] } : n)), edges: [] } });
  try {
    run('scan.mjs', ownHost);
    run('build.mjs', ownHost, '--no-claude-md');
    const g = readGraph(ownHost);
    assert.ok(g.links.some((l) => l.a === `f:${M}api/Base.java` && l.b === 'n:server' && l.k === 'http'), 'the address is drawn as an edge');
    assert.equal(g.links.filter((l) => l.out).length, 0);
  } finally { cleanup(ownHost); }
});

test('A call a project route fits is not listed as outside, even a repeat of it, one too many routes fit or one that fits only loosely, and those are counted', () => {
  const server = (name, line) => [`package com.example.server;`, '', 'import org.springframework.web.bind.annotation.*;', '', '@RestController', `public class ${name} {`, `    ${line}`, '    public void handle() {}', '}'].join('\n');
  const project = {
    [M + 'api/PingService.kt']: [
      'package com.example.app.api',
      '',
      'import retrofit2.http.GET',
      '',
      'interface PingService {',
      '    @GET("ping")',
      '    suspend fun ping(): Response',
      '    @GET("ping")',
      '    suspend fun pingAgain(): Response',
      '    @GET("items")',
      '    suspend fun items(): Response',
      '    @GET("user")',
      '    suspend fun user(): Response',
      '}',
    ].join('\n'),
    'server/src/main/java/com/example/server/PingController.java': server('PingController', '@GetMapping("/ping")'),
    ...Object.fromEntries([0, 1, 2, 3, 4].map((v) => [`server/src/main/java/com/example/server/Items${v}.java`, server(`Items${v}`, `@GetMapping("/v${v}/items")`)])),
    'server/src/main/java/com/example/server/StatsController.java': server('StatsController', '@GetMapping("/api/v1/admin/stats/user")'),
  };
  const root = makeProject(project, { repos: ['.'], arch });
  try {
    assert.doesNotMatch(run('scan.mjs', root), /RETROFIT REQUESTS NO SCANNED ROUTE ANSWERS/);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(s.http.map((h) => `${h.method} ${h.path}`), ['GET /ping']);
    assert.deepEqual(s.unmatchedCalls.map((c) => `${c.path} ${c.loose}`), ['items true', 'user true']);
    const out = run('build.mjs', root, '--no-claude-md');
    assert.match(out, /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 2 that a scanned endpoint fits only loosely, on no edge\n/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('Calls go on the outside edge of the nearest code that has one, and code with edges to two services lists none', () => {
  const two = {
    ...arch,
    nodes: [...arch.nodes, { id: 'stats', label: 'Stats service', kind: 'external' }],
    edges: [
      { from: 'api', to: 'music-server', kind: 'http' },
      { from: 'api', to: 'stats', kind: 'http' },
      { from: M + 'api/SystemService.kt', to: 'music-server', kind: 'http' },
    ],
  };
  const root = makeProject(files, { repos: ['.'], arch: two });
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--no-claude-md');
    assert.match(out, /OUTSIDE CALLS {2}1 Retrofit requests on http edges to outside services · 2 from code with http edges to more than one server, so none is listed/);
    const g = readGraph(root);
    assert.deepEqual(g.links.filter((l) => l.out).map((l) => `${l.a} ${l.out.map(([m, p]) => `${m} ${p}`).join(',')}`), [`f:${M}api/SystemService.kt GET ping`]);
  } finally { cleanup(root); }
});

const G = M + 'github/';
const hosted = (name, host, endpoint) => [`package com.example.app.github;`, '', 'import retrofit2.http.GET;', '', `public class ${name} {`, '    public String getUrl() {', `        return "https://${host}/";`, '    }',
  ...(endpoint ? ['    interface Requests {', `        @GET("${endpoint}")`, '        Call<Object> load();', '    }'] : []), '}'].join('\n');
const hostArch = {
  project: { name: 'Music app' },
  nodes: [
    { id: 'updates', label: 'Update check', kind: 'feature', paths: [G + '**'] },
    { id: 'github', label: 'GitHub', kind: 'external', hosts: ['api.github.com'] },
    { id: 'stats', label: 'Stats service', kind: 'external', hosts: ['stats.musicapp.io'] },
  ],
  edges: [],
};

test('A request in a file beside the one holding an outside service\'s address is not put on that address\'s edge, and an edge drawn from its node lists it', () => {
  const release = ['package com.example.app.github.release;', '', 'import retrofit2.http.GET;', '', 'public interface ReleaseService {', '    @GET("repos/{owner}/{repo}/releases/latest")', '    Call<Object> latest();', '}'].join('\n');
  const root = makeProject({ [G + 'Github.java']: hosted('Github', 'api.github.com'), [G + 'release/ReleaseService.java']: release }, { repos: ['.'], arch: hostArch });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 more no scanned route answers/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
  const drawn = makeProject({ [G + 'Github.java']: hosted('Github', 'api.github.com'), [G + 'release/ReleaseService.java']: release }, { repos: ['.'], arch: { ...hostArch, edges: [{ from: 'updates', to: 'github', kind: 'http' }] } });
  try {
    run('scan.mjs', drawn);
    assert.match(run('build.mjs', drawn, '--no-claude-md'), /OUTSIDE CALLS {2}1 Retrofit requests on http edges to outside services\n/);
    assert.deepEqual(outs(drawn), ['n:updates -> n:github GET repos/{owner}/{repo}/releases/latest ReleaseService.java']);
  } finally { cleanup(drawn); }
});

test('A request in the file holding an outside service\'s address goes on its edge, even with other services beside it', () => {
  const root = makeProject({ [G + 'Github.java']: hosted('Github', 'api.github.com', 'repos/latest'), [G + 'Stats.java']: hosted('Stats', 'stats.musicapp.io', 'events/daily') }, { repos: ['.'], arch: hostArch });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}2 Retrofit requests on http edges to outside services\n/);
    assert.deepEqual(outs(root).sort(), ['Github.java -> n:github GET repos/latest Github.java', 'Stats.java -> n:stats GET events/daily Stats.java']);
  } finally { cleanup(root); }
});

test('Files no node holds do not share an outside service\'s address with each other', () => {
  const feed = ['package com.example.other;', '', 'import retrofit2.http.GET;', '', 'public interface Feed {', '    @GET("feeds/latest")', '    Call<Object> latest();', '}'].join('\n');
  const root = makeProject({ [G + 'Github.java']: hosted('Github', 'api.github.com'), 'other/Cdn.java': hosted('Cdn', 'api.github.com'), 'other/Feed.java': feed }, { repos: ['.'], arch: hostArch });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 more no scanned route answers/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('An http edge from an outside service to itself is left out without stopping the build', () => {
  const self = {
    ...arch,
    nodes: arch.nodes.map((n) => (n.id === 'api' ? { ...n, paths: ['nowhere/**'] } : n.id === 'music-server' ? { ...n, paths: [M + 'api/**'] } : n)),
    edges: [{ from: 'music-server', to: 'music-server', kind: 'http' }],
  };
  const root = makeProject(files, { repos: ['.'], arch: self });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    assert.equal(readGraph(root).links.filter((l) => l.out).length, 0);
  } finally { cleanup(root); }
});

test('The same annotations from another library (Ktorfit) are still read as requests to an address', () => {
  assert.deepEqual(calls([
    'package com.example.api',
    '',
    'import de.jensklingenberg.ktorfit.http.GET',
    '',
    'interface UserApi {',
    '    @GET("/api/users/{id}")',
    '    suspend fun user(id: String): User',
    '}',
  ].join('\n'), 'kotlin'), ['GET /api/users/{id}']);
});

test('A secret in a request address is hidden on the map and in scan.json', () => {
  const token = ['1234567890', 'AAHq7Zx2Lm9Pw4Rt6Yu8Io1As3Df5Gh7Jk0'].join(':');
  const bot = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface BotService {', `    @GET("relay/${token}/getMe")`, '    suspend fun me(): Response', '}'].join('\n');
  const root = makeProject({ ...files, [M + 'api/BotService.kt']: bot }, { repos: ['.'], arch });
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--no-claude-md');
    assert.match(out, /secret-looking text in app\/src\/main\/java\/com\/example\/app\/api\/BotService\.kt \(request on line 6\)/);
    assert.ok(!fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8').includes(token));
    assert.ok(!fs.readFileSync(path.join(root, 'floorplan', 'graph.json'), 'utf8').includes(token));
    assert.ok(!fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8').includes(token));
    const edge = readGraph(root).links.find((l) => l.b === 'n:music-server');
    assert.ok(edge.out.some(([, p]) => p === 'relay/«hidden»/getMe'));
  } finally { cleanup(root); }
});

test('A secret is hidden one path segment at a time, and two hidden requests in one file are both listed', () => {
  const ids = [['1BxiMVs0XRA5nFMd', 'KvBdBZjgmUUqptlbs74OgvE2upms'], ['1Zk8QpX3vR7mT2wY', '9bN4cL6hJ0sD5fG1aE8uI3oP'], ['8Nf2kQ0zLmP4', 'rT7vW1xY3bC5'], ['aB3x', 'cD4y', 'eF5z', 'gH6w', 'iJ7v', 'kL8u', 'mN9t'].join('/')].map((x) => (Array.isArray(x) ? x.join('') : x));
  const drive = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface DriveService {', `    @GET("drive/v3/files/${ids[0]}")`, '    suspend fun one(): Response', `    @GET("drive/v3/files/${ids[1]}")`, '    suspend fun two(): Response',
    '    @GET("users/{id}/profile")', '    suspend fun profile(): Response', `    @POST("services/T024BE7LD/B01234567/${ids[2]}")`, '    suspend fun post(): Response', `    @GET("${ids[3]}")`, '    suspend fun split(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/DriveService.kt']: drive }, { repos: ['.'], arch });
  try {
    run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    // no one segment of the webhook address looks secret, but the address does, so its generated looking segment is
    // hidden, and a path with no such segment is hidden whole
    assert.deepEqual(s.unmatchedCalls.map((c) => `${c.path} ${!!c.hidden}`), ['drive/v3/files/«hidden» true', 'drive/v3/files/«hidden» true', 'users/{id}/profile false', 'services/T024BE7LD/B01234567/«hidden» true', '«hidden» true']);
    const out = run('build.mjs', root, '--no-claude-md');
    assert.match(out, /OUTSIDE CALLS {2}5 Retrofit requests on http edges to outside services\n/);
    assert.match(out, /DriveService\.kt \(request on line 6, request on line 8, request on line 12, request on line 14\)/);
    assert.deepEqual(readGraph(root).links.find((l) => l.b === 'n:music-server').out.map(([, p, , line]) => `${p} @${line}`), ['drive/v3/files/«hidden» @6', 'drive/v3/files/«hidden» @8', 'users/{id}/profile @10', 'services/T024BE7LD/B01234567/«hidden» @12', '«hidden» @14']);
    for (const f of [path.join('.cache', 'scan.json'), 'graph.json', 'index.html']) assert.ok(!ids.some((id) => fs.readFileSync(path.join(root, 'floorplan', f), 'utf8').includes(id)), f);
  } finally { cleanup(root); }
});

test('An edge lists at most 400 calls, and the build report counts the rest as left off that edge', () => {
  const many = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface BigService {',
    ...Array.from({ length: 405 }, (_, i) => `    @GET("end${i}")\n    suspend fun end${i}(): Response`), '}'].join('\n');
  const small = ['package com.example.app.stats', '', 'import retrofit2.http.GET', '', 'interface StatsService {', '    @GET("daily")', '    suspend fun daily(): Response', '}'].join('\n');
  const two = { ...arch, nodes: [...arch.nodes, { id: 'stats-code', label: 'Stats', kind: 'feature', paths: [M + 'stats/**'] }, { id: 'stats', label: 'Stats service', kind: 'external' }], edges: [...arch.edges, { from: 'stats-code', to: 'stats', kind: 'http' }] };
  const root = makeProject({ [M + 'api/BigService.kt']: many, [M + 'stats/StatsService.kt']: small }, { repos: ['.'], arch: two });
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--no-claude-md');
    assert.match(out, /OUTSIDE CALLS {2}401 Retrofit requests on http edges to outside services · 5 left off edges that already list 400\n/);
    assert.equal(readGraph(root).links.find((l) => l.b === 'n:music-server').out.length, 400);
    assert.equal(readGraph(root).links.find((l) => l.b === 'n:stats').out.length, 1);
  } finally { cleanup(root); }
});

test('Retrofit: @HTTP split across lines is read, and one never closed does not slow the reading down', () => {
  assert.deepEqual(calls([
    'package com.example.api',
    '',
    'import retrofit2.http.HTTP',
    '',
    'interface S {',
    '    @HTTP(',
    '        method = "DELETE",',
    '        path = "users/{id}",',
    '        hasBody = true',
    '    )',
    '    suspend fun remove(id: String)',
    '}',
  ].join('\n'), 'kotlin'), ['DELETE users/{id}']);
  const hostile = 'package a\n\nimport retrofit2.http.HTTP\n\n' + '@HTTP(method = "GET", path = "x"\n'.repeat(10000);
  const t = performance.now();
  extract(hostile, 'kotlin', 'H.kt');
  assert.ok(performance.now() - t < 1500, `took ${Math.round(performance.now() - t)} ms`);
});

test('A request written with a full address goes only on the edge read from that address in its own file', () => {
  const direct = ['package com.example.app.github;', '', 'import retrofit2.http.GET;', '', 'public interface Direct {', '    @GET("https://api.github.com/repos/latest")', '    Call<Object> latest();', '    @GET("https://cdn.feedhost.io/feed")', '    Call<Object> feed();', '}'].join('\n');
  // a route in the project with the same path does not answer a request sent to another host
  const own = ['package com.example.server;', '', 'import org.springframework.web.bind.annotation.*;', '', '@RestController', 'public class Repos {', '    @GetMapping("/repos/latest")', '    public void latest() {}', '}'].join('\n');
  const root = makeProject({ [G + 'Direct.java']: direct, 'server/Repos.java': own }, { repos: ['.'], arch: { ...hostArch, edges: [{ from: 'updates', to: 'stats', kind: 'http' }] } });
  try {
    assert.match(run('scan.mjs', root), /RETROFIT REQUESTS NO SCANNED ROUTE ANSWERS {2}2\b/);
    assert.deepEqual(readJson(path.join(root, 'floorplan', '.cache', 'scan.json')).http, []);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}1 Retrofit requests on http edges to outside services · 1 written with a full address whose host is in no node's hosts; add it to its external node's hosts to list them there, or to the hosts of the project node whose server answers it\n/);
    assert.deepEqual(outs(root), ['Direct.java -> n:github GET /repos/latest Direct.java']);
  } finally { cleanup(root); }
});

test('An edge drawn from a parent node lists its child nodes\' requests, but an address in a parent node\'s file is not shared with them', () => {
  const feed = ['package com.example.app.feed;', '', 'import retrofit2.http.GET;', '', 'public interface FeedService {', '    @GET("feeds/latest")', '    Call<Object> latest();', '}'].join('\n');
  const project = { [M + 'Base.java']: hosted('Base', 'api.github.com'), [M + 'feed/FeedService.java']: feed };
  const nested = { project: { name: 'Feed app' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', paths: [M + '**'] }, { id: 'feed', label: 'Feed', kind: 'feature', parent: 'app', paths: [M + 'feed/**'] }, { id: 'github', label: 'GitHub', kind: 'external', hosts: ['api.github.com'] }], edges: [] };
  const root = makeProject(project, { repos: ['.'], arch: nested });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 more no scanned route answers/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
  const drawn = makeProject(project, { repos: ['.'], arch: { ...nested, edges: [{ from: 'app', to: 'github', kind: 'http' }] } });
  try {
    run('scan.mjs', drawn);
    run('build.mjs', drawn, '--no-claude-md');
    assert.deepEqual(outs(drawn), ['n:app -> n:github GET feeds/latest FeedService.java']);
  } finally { cleanup(drawn); }
});

test('Requests in a file the map leaves out (ignore) are neither listed nor counted', () => {
  const root = makeProject(files, { repos: ['.'], arch: { ...arch, ignore: [M + 'api/SystemService.kt'] } });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}2 Retrofit requests on http edges to outside services\n/);
    assert.deepEqual(readGraph(root).links.find((l) => l.b === 'n:music-server').out.map(([m, p]) => `${m} ${p}`).sort(), ['GET getAlbum', 'GET getArtist']);
  } finally { cleanup(root); }
});

test('A full address in one request\'s annotation does not take the other requests in its file, and two in one file are no reason to list none', () => {
  const api = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface MixedService {', '    @GET("getAlbum")', '    suspend fun album(): Response', '    @GET("getArtist")', '    suspend fun artist(): Response',
    '    @GET("https://api.github.com/repos/o/r/releases/latest")', '    suspend fun latest(): Response', '    @GET("https://stats.musicapp.io/v1/events")', '    suspend fun events(): Response', '}'].join('\n');
  const mixed = { ...arch, nodes: [...arch.nodes, { id: 'github', label: 'GitHub', kind: 'external', hosts: ['api.github.com'] }, { id: 'stats', label: 'Stats service', kind: 'external', hosts: ['stats.musicapp.io'] }] };
  const root = makeProject({ [M + 'api/MixedService.kt']: api }, { repos: ['.'], arch: mixed });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}4 Retrofit requests on http edges to outside services\n/);
    assert.deepEqual(outs(root).sort(), [
      'MixedService.kt -> n:github GET /repos/o/r/releases/latest MixedService.kt',
      'MixedService.kt -> n:stats GET /v1/events MixedService.kt',
      'n:api -> n:music-server GET getAlbum MixedService.kt,GET getArtist MixedService.kt',
    ]);
  } finally { cleanup(root); }
});

test('An address in an annotation joined from strings keeps the edge 0.11.0 drew without taking its file\'s requests, and one split across lines is one host', () => {
  const joined = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface Items {', '    @GET("https://api.items.io/v1/" + "items")', '    suspend fun items(): Response', '    @GET("users")', '    suspend fun users(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/Items.kt']: joined }, { repos: ['.'], arch: { ...arch, nodes: [...arch.nodes, { id: 'items', label: 'Items', kind: 'external', hosts: ['api.items.io'] }], edges: [] } });
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--no-claude-md');
    assert.doesNotMatch(out, /node "items" hosts match no host/);
    assert.ok(readGraph(root).links.some((l) => l.a === `f:${M}api/Items.kt` && l.b === 'n:items' && l.k === 'http'));
    assert.match(out, /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 more no scanned route answers/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
  const split = extract(['package a', '', 'import retrofit2.http.GET', '', 'interface S {', '    @GET(', '        "https://api.items.io/v1/items"', '    )', '    suspend fun items(): Response', '}'].join('\n'), 'kotlin', 'S.kt');
  assert.deepEqual(split.hosts.map((h) => h.host), ['api.items.io']);
  assert.deepEqual(split.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/items']);
});

test('A full address with no external node naming its host is counted on its own, and the scan summary says where those go', () => {
  const feed = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface Feed {', '    @GET("https://cdn.feedhost.io/feed/latest")', '    suspend fun latest(): Response', '    @GET("https://reports.musicapp.io/v1/status")', '    suspend fun status(): Response', '}'].join('\n');
  const nodes = [...arch.nodes.map((n) => (n.id === 'server' ? { ...n, hosts: ['reports.musicapp.io'] } : n)), { id: 'feedhost', label: 'Feed host', kind: 'external' }];
  const root = makeProject({ [M + 'api/Feed.kt']: feed }, { repos: ['.'], arch: { ...arch, nodes, edges: [{ from: M + 'api/Feed.kt', to: 'feedhost', kind: 'http' }] } });
  try {
    assert.match(run('scan.mjs', root), /RETROFIT REQUESTS NO SCANNED ROUTE ANSWERS {2}2, by folder \(.*; the 2 written with a full address are not compared with the scanned routes, and are listed by the external node whose hosts name that address's host\)/);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 written with a full address whose host is in no node's hosts; add it to its external node's hosts to list them there, or to the hosts of the project node whose server answers it · 1 going to a part of the project, by a full address whose host it names or from code whose http edge goes to it, not listed\n/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('Retrofit: a full address read as a file name or with no word in its path is still a request, and a path of only interpolations, dots or slashes is not', () => {
  const r = extract(['package a', '', 'import retrofit2.http.GET', '', 'interface S {',
    ...['https://raw.githubusercontent.com/o/r/main/version.json', 'https://x.io/v1', 'https://y.io/', '${Api.LATEST}', '${Api.A}/${Api.B}', '..', '../', '${Api.BASE}/users'].flatMap((x, i) => [`    @GET("${x}")`, `    suspend fun f${i}(): Response`]), '}'].join('\n'), 'kotlin', 'S.kt');
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}${c.host ? ' ' + c.host : ''}`), ['GET /o/r/main/version.json raw.githubusercontent.com', 'GET /v1 x.io', 'GET ${Api.BASE}/users']);
  assert.deepEqual(r.hosts.map((h) => h.host), ['raw.githubusercontent.com', 'x.io', 'y.io']);
});

test('The map lists every request an edge carries, two masked ones in one file included', () => {
  const viewer = fs.readFileSync(new URL('../skills/floorplan/assets/viewer.html', import.meta.url), 'utf8');
  const src = /^const outsideOf = .*$/m.exec(viewer)?.[0];
  assert.ok(src, 'outsideOf in viewer.html');
  const outsideOf = new Function(`${src}\nreturn outsideOf;`)();
  const rows = outsideOf([{ out: [['GET', 'users/«hidden»', 'a/S.kt', 6], ['GET', 'users/«hidden»', 'a/S.kt', 8]] }, { out: [['GET', 'ping', 'a/T.kt', 3]] }, {}]);
  assert.deepEqual(rows.map(([, p, , line]) => `${p} @${line}`), ['users/«hidden» @6', 'users/«hidden» @8', 'ping @3']);
});

test('A token beside an id that looks generated hides the id too, on the map and in scan.json', () => {
  const token = ['xoxb', '2048', '1234567890', 'zq8lm4rt6yu2io9as3df'].join('-');
  const id = ['UCx9Kq2', 'LmP4Rt7', 'Wb3'].join('');
  const bots = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface BotService {', `    @GET("bots/${token}/channels/${id}")`, '    suspend fun channel(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/BotService.kt']: bots }, { repos: ['.'], arch });
  try {
    run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(s.unmatchedCalls.map((c) => `${c.path} ${!!c.hidden}`), ['bots/«hidden»/channels/«hidden» true']);
    run('build.mjs', root, '--no-claude-md');
    assert.deepEqual(readGraph(root).links.find((l) => l.b === 'n:music-server').out.map(([, p]) => p), ['bots/«hidden»/channels/«hidden»']);
    for (const f of [path.join('.cache', 'scan.json'), 'graph.json', 'index.html']) assert.ok(![token, id].some((v) => fs.readFileSync(path.join(root, 'floorplan', f), 'utf8').includes(v)), f);
  } finally { cleanup(root); }
});

test('Retrofit: a full address read from the address itself keeps its host in lower case', () => {
  const r = extract(['package a', '', 'import retrofit2.http.GET', '', 'interface S {', '    @GET("https://Raw.GitHubusercontent.com/o/r/main/version.json")', '    suspend fun version(): Response', '}'].join('\n'), 'kotlin', 'S.kt');
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path} ${c.host}`), ['GET /o/r/main/version.json raw.githubusercontent.com']);
  assert.deepEqual(r.hosts.map((h) => h.host), ['raw.githubusercontent.com']);
});

test('Retrofit: an @HTTP before a verb annotation in the file is not read a second time as a request with no method', () => {
  assert.deepEqual(calls(['package a', '', 'import retrofit2.http.*', '', 'interface S {', '    @HTTP(method = "DELETE", path = "/api/things/{id}", hasBody = true)', '    suspend fun remove(): Response', '    @GET("/users")', '    suspend fun users(): Response', '}'].join('\n'), 'kotlin'), ['DELETE /api/things/{id}', 'GET /users']);
});

test('One path written with full addresses to two hosts in one file is listed on both hosts\' edges', () => {
  const api = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface StatusService {', '    @GET("https://api.github.com/v1/status")', '    suspend fun github(): Response', '    @GET("https://stats.musicapp.io/v1/status")', '    suspend fun stats(): Response', '}'].join('\n');
  const both = { ...arch, nodes: [...arch.nodes, { id: 'github', label: 'GitHub', kind: 'external', hosts: ['api.github.com'] }, { id: 'stats', label: 'Stats service', kind: 'external', hosts: ['stats.musicapp.io'] }] };
  const root = makeProject({ [M + 'api/StatusService.kt']: api }, { repos: ['.'], arch: both });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}2 Retrofit requests on http edges to outside services\n/);
    assert.deepEqual(outs(root).sort(), ['StatusService.kt -> n:github GET /v1/status StatusService.kt', 'StatusService.kt -> n:stats GET /v1/status StatusService.kt']);
  } finally { cleanup(root); }
});

test('Retrofit: a full address whose host is built at run time gives no host and no request, a host with letters outside ASCII or in brackets is read, and a Firebase function\'s address is a request with no host', () => {
  const r = extract(['package a', '', 'import retrofit2.http.GET', '', 'interface S {', ...['https://api-${Cfg.ENV}.musicapp.io/v1/status', 'https://api.$region.musicapp.io/v1/items', 'https://api.${Cfg.DOMAIN}/v1/status', 'https://api-${Cfg.ENV}/v1/items', 'https://api.musicapp.io:${Cfg.PORT}/v1/items', 'https://api.musicapp.io/v1/ok', 'https://müsik.io/v1/users', 'http://[2001:db8::1]:8080/v1/x', 'https://us-central1-demo.cloudfunctions.net/signDocument'].flatMap((x, i) => [`    @GET("${x}")`, `    suspend fun f${i}(): Response`]), '}'].join('\n'), 'kotlin', 'S.kt');
  assert.deepEqual(r.hosts.map((h) => h.host), ['api.musicapp.io', 'müsik.io', '[2001:db8::1]:8080']);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path} ${c.host}`), ['GET /v1/ok api.musicapp.io', 'GET /v1/users müsik.io', 'GET /v1/x [2001:db8::1]:8080', 'GET /signDocument undefined']);
});

test('A token split by slashes is hidden when another token in the same path was hidden on its own', () => {
  const token = ['xoxb', '2048', '1234567890', 'zq8lm4rt6yu2io9as3df'].join('-');
  const split = ['aB3x', 'cD4y', 'eF5z', 'gH6w', 'iJ7v', 'kL8u', 'mN9t'].join('/');
  const bots = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface BotService {', `    @GET("bots/${token}/${split}")`, '    suspend fun channel(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/BotService.kt']: bots }, { repos: ['.'], arch });
  try {
    run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(s.unmatchedCalls.map((c) => `${c.path} ${!!c.hidden}`), ['bots/«hidden»«hidden» true']);
    run('build.mjs', root, '--no-claude-md');
    for (const f of [path.join('.cache', 'scan.json'), 'graph.json', 'index.html']) assert.ok(![token, split, 'gH6w/iJ7v'].some((v) => fs.readFileSync(path.join(root, 'floorplan', f), 'utf8').includes(v)), f);
  } finally { cleanup(root); }
});

test('A token written as a name and value inside one segment is hidden even when the whole path does not look secret', () => {
  const value = ['Zx81Qa7', 'Lm3Np9R', 't2Vb6Wc4'].join('');
  const users = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface UserService {', `    @GET("users/42/token:${value}/send")`, '    suspend fun send(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/UserService.kt']: users }, { repos: ['.'], arch });
  try {
    run('scan.mjs', root);
    const s = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(s.unmatchedCalls.map((c) => `${c.path} ${!!c.hidden}`), ['users/42/token:«hidden»/send true']);
    run('build.mjs', root, '--no-claude-md');
    for (const f of [path.join('.cache', 'scan.json'), 'graph.json', 'index.html']) assert.ok(!fs.readFileSync(path.join(root, 'floorplan', f), 'utf8').includes(value), f);
  } finally { cleanup(root); }
});

test('A Firebase function address no scanned function answers is on no edge and not counted', () => {
  const sign = ['package com.example.app.api', '', 'import retrofit2.http.POST', '', 'interface SignService {', '    @POST("https://us-central1-demo.cloudfunctions.net/signDocument")', '    suspend fun sign(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/SignService.kt']: sign }, { repos: ['.'], arch });
  try {
    run('scan.mjs', root);
    assert.deepEqual(readJson(path.join(root, 'floorplan', '.cache', 'scan.json')).unmatchedCalls, []);
    assert.doesNotMatch(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('A project node given a host links from its own files as from a file outside it', () => {
  const url = (pkg, name) => [`package ${pkg};`, '', `public class ${name} {`, '    public String getUrl() {', '        return "https://reports.musicapp.io/";', '    }', '}'].join('\n');
  const project = { [M + 'api/Base.java']: url('com.example.app.api', 'Base'), 'server/src/main/java/com/example/server/SelfCheck.java': url('com.example.server', 'SelfCheck') };
  const root = makeProject(project, { repos: ['.'], arch: { ...arch, nodes: arch.nodes.map((n) => (n.id === 'server' ? { ...n, hosts: ['reports.musicapp.io'] } : n)), edges: [] } });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    assert.deepEqual(readGraph(root).links.filter((l) => l.b === 'n:server' && l.k === 'http').map((l) => l.a).sort(), [`f:${M}api/Base.java`, 'f:server/src/main/java/com/example/server/SelfCheck.java']);
  } finally { cleanup(root); }
});

test('A full address request in a file inside the external node that claims its host is listed on the link from that file', () => {
  const svc = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface Direct {', '    @GET("https://api.github.com/repos/latest")', '    suspend fun latest(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/Direct.kt']: svc }, { repos: ['.'], arch: { project: { name: 'X' }, nodes: [{ id: 'app', label: 'App', kind: 'ui', paths: [M + 'ui/**'] }, { id: 'github', label: 'GitHub', kind: 'external', hosts: ['api.github.com'], paths: [M + 'api/**'] }], edges: [] } });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS  1 /);
    assert.deepEqual(readGraph(root).links.filter((l) => l.b === 'n:github' && l.k === 'http').map((l) => l.a), [`f:${M}api/Direct.kt`]);
    assert.deepEqual(outs(root), ['Direct.kt -> n:github GET /repos/latest Direct.kt']);
  } finally { cleanup(root); }
});

test('A file in a child node of the project node given a host links to it too', () => {
  const url = (pkg, name) => [`package ${pkg};`, '', `public class ${name} {`, '    public String getUrl() {', '        return "https://reports.musicapp.io/";', '    }', '}'].join('\n');
  const project = { [M + 'api/Base.java']: url('com.example.app.api', 'Base'), 'server/api/src/main/java/com/example/server/api/SelfCheck.java': url('com.example.server.api', 'SelfCheck') };
  const nodes = [...arch.nodes.map((n) => (n.id === 'server' ? { ...n, hosts: ['reports.musicapp.io'] } : n)), { id: 'server.api', parent: 'server', label: 'Report API', kind: 'service', paths: ['server/api/**'] }];
  const root = makeProject(project, { repos: ['.'], arch: { ...arch, nodes, edges: [] } });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    const g = readGraph(root);
    assert.equal(g.files.find((f) => f.p === 'server/api/src/main/java/com/example/server/api/SelfCheck.java').n, 'server.api');
    assert.deepEqual(g.links.filter((l) => l.b === 'n:server' && l.k === 'http').map((l) => l.a).sort(), [`f:${M}api/Base.java`, 'f:server/api/src/main/java/com/example/server/api/SelfCheck.java']);
  } finally { cleanup(root); }
});

test('A request in a file inside an external node under a project node is listed on the link from that file, not on the project node link to another service', () => {
  const pay = ['package com.example.app.pay', '', 'import retrofit2.http.POST', '', 'object Cfg { const val BASE = "https://api.stripe.com/" }', 'interface Pay {', '    @POST("v1/charges")', '    suspend fun charge(): Response', '}'].join('\n');
  const music = ['package com.example.app.ui', '', 'import retrofit2.http.GET', '', 'interface Music {', '    @GET("getAlbum")', '    suspend fun album(): Response', '}'].join('\n');
  const nodes = [{ id: 'app', label: 'App', kind: 'ui', paths: ['app/**'] }, { id: 'app.pay', parent: 'app', label: 'Payments', kind: 'external', hosts: ['api.stripe.com'], paths: [M + 'pay/**'] }, { id: 'music', label: 'Music server', kind: 'external' }];
  const root = makeProject({ [M + 'pay/Pay.kt']: pay, [M + 'ui/Music.kt']: music }, { repos: ['.'], arch: { project: { name: 'X' }, nodes, edges: [{ from: 'app', to: 'music', kind: 'http' }] } });
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md');
    assert.deepEqual(outs(root).sort(), ['Pay.kt -> n:app.pay POST v1/charges Pay.kt', 'n:app -> n:music GET getAlbum Music.kt']);
  } finally { cleanup(root); }
});

const ownBase = (...hosts) => ['package com.example.app.api', '', 'import retrofit2.Retrofit', 'import retrofit2.http.GET', '', ...hosts.map((h, i) => `val r${i} = Retrofit.Builder().baseUrl("https://${h}/").build()`), 'interface Api {', '    @GET("orders/open")', '    suspend fun open(): Response', '}'].join('\n');
const ownNodes = [{ id: 'app', label: 'App', kind: 'ui', paths: ['app/**'] }, { id: 'srv', label: 'Server', kind: 'service', hosts: ['api.myapp.com'], paths: ['srv/**'] }, { id: 'maps', label: 'Maps', kind: 'external' }, { id: 'stripe', label: 'Stripe', kind: 'external', hosts: ['api.stripe.com'] }];

test('A request in a file whose address is the project\'s own server is counted, not listed on a parent\'s edge to an outside service', () => {
  const root = makeProject({ [M + 'api/Api.kt']: ownBase('api.myapp.com'), 'srv/index.js': 'module.exports = 1;\n' }, { repos: ['.'], arch: { project: { name: 'X' }, nodes: ownNodes, edges: [{ from: 'app', to: 'maps', kind: 'http' }] } });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 going to a part of the project, by a full address whose host it names or from code whose http edge goes to it, not listed/);
    assert.ok(readGraph(root).links.some((l) => l.a === `f:${M}api/Api.kt` && l.b === 'n:srv' && l.k === 'http'));
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('An http edge drawn to a part of the project counts that code\'s requests as going there, not on its node\'s edge to an outside service', () => {
  const root = makeProject(files, { repos: ['.'], arch: { ...arch, edges: [...arch.edges, { from: M + 'api/SystemService.kt', to: 'server', kind: 'http' }] } });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}2 Retrofit requests on http edges to outside services · 1 going to a part of the project/);
    assert.deepEqual(outs(root), ['n:api -> n:music-server GET getAlbum BrowsingService.java,GET getArtist BrowsingService.java']);
  } finally { cleanup(root); }
});

test('A file with addresses of the project\'s own server and of an outside service lists none of its requests', () => {
  const root = makeProject({ [M + 'api/Api.kt']: ownBase('api.myapp.com', 'api.stripe.com'), 'srv/index.js': 'module.exports = 1;\n' }, { repos: ['.'], arch: { project: { name: 'X' }, nodes: ownNodes, edges: [] } });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 from code with http edges to more than one server, so none is listed/);
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('An http edge drawn to a file of the project counts that code\'s requests as going there, not on its node\'s edge to an outside service', () => {
  const api = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface Api {', '    @GET("orders/open")', '    suspend fun open(): Response', '}'].join('\n');
  const root = makeProject({ [M + 'api/Api.kt']: api, 'srv/index.js': 'module.exports = 1;\n' }, { repos: ['.'], arch: { project: { name: 'X' }, nodes: ownNodes, edges: [{ from: 'app', to: 'maps', kind: 'http' }, { from: M + 'api/Api.kt', to: 'srv/index.js', kind: 'http' }] } });
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 going to a part of the project/);
    assert.ok(readGraph(root).links.some((l) => l.a === `f:${M}api/Api.kt` && l.b === 'f:srv/index.js' && l.k === 'http'));
    assert.deepEqual(outs(root), []);
  } finally { cleanup(root); }
});

test('An http edge drawn from a part to a part of the project counts that part\'s requests as going there, and one more to an outside service lists none', () => {
  const api = ['package com.example.app.api', '', 'import retrofit2.http.GET', '', 'interface Api {', '    @GET("orders/open")', '    suspend fun open(): Response', '}'].join('\n');
  const project = { [M + 'api/Api.kt']: api, 'srv/index.js': 'module.exports = 1;\n' };
  const own = makeProject(project, { repos: ['.'], arch: { project: { name: 'X' }, nodes: ownNodes, edges: [{ from: 'app', to: 'srv', kind: 'http' }] } });
  try {
    run('scan.mjs', own);
    assert.match(run('build.mjs', own, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 going to a part of the project/);
    assert.deepEqual(outs(own), []);
  } finally { cleanup(own); }
  const two = makeProject(project, { repos: ['.'], arch: { project: { name: 'X' }, nodes: ownNodes, edges: [{ from: 'app', to: 'srv', kind: 'http' }, { from: 'app', to: 'maps', kind: 'http' }] } });
  try {
    run('scan.mjs', two);
    assert.match(run('build.mjs', two, '--no-claude-md'), /OUTSIDE CALLS {2}0 Retrofit requests on http edges to outside services · 1 from code with http edges to more than one server, so none is listed/);
    assert.deepEqual(outs(two), []);
  } finally { cleanup(two); }
});
