import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkEvidenceUrls, createPublicLookup } from "./security";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("uses Node's request lookup contract for public IPv4 and IPv6 addresses", async () => {
  const resolverCalls: Array<{ hostname: string; all: boolean | undefined }> = [];
  const probeAddress = async (hostname: string, address: string, family: number) => {
    let transportRequest: http.ClientRequest;
    let finished = false;
    const lookup = createPublicLookup((hostname, options, callback) => {
      resolverCalls.push({ hostname, all: options.all });
      queueMicrotask(() => {
        callback(null, [{ address, family }]);
        queueMicrotask(() => {
          if (!finished) transportRequest.destroy(new Error("transport_probe_complete"));
        });
      });
    });
    const error = await new Promise<Error>((resolve) => {
      transportRequest = http.request({
        hostname,
        port: 9,
        autoSelectFamily: false,
        lookup,
      } as http.RequestOptions);
      transportRequest.once("error", (requestError) => {
        finished = true;
        resolve(requestError);
      });
      transportRequest.end();
    });
    assert.doesNotMatch(error.message, /invalid ip address/i);
  };
  await probeAddress("citation-v4.example", "93.184.216.34", 4);
  await probeAddress("citation-v6.example", "2606:2800:220:1:248:1893:25c8:1946", 6);
  assert.deepEqual(resolverCalls, [
    { hostname: "citation-v4.example", all: true },
    { hostname: "citation-v6.example", all: true },
  ]);

  const lookup = createPublicLookup((_hostname, _options, callback) => callback(null, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]));
  const lookupAll = lookup as unknown as (
    hostname: string,
    options: { all: true },
    callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void,
  ) => void;
  const allAddresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    lookupAll("citation.example", { all: true }, (lookupError, addresses) => {
      if (lookupError) reject(lookupError);
      else resolve(addresses);
    });
  });
  assert.deepEqual(allAddresses.map(({ family }) => family), [4, 6]);

  const blockedLookup = createPublicLookup((_hostname, _options, callback) => {
    callback(null, [{ address: "10.0.0.8", family: 4 }]);
  });
  await assert.rejects(
    new Promise((resolve, reject) => {
      (blockedLookup as unknown as typeof lookupAll)("private.example", { all: true }, (lookupError, addresses) => {
        if (lookupError) reject(lookupError);
        else resolve(addresses);
      });
    }),
    /blocked_destination/,
  );
});

test("follows a bounded redirect to reachable evidence", async () => {
  const seen: string[] = [];
  const [result] = await checkEvidenceUrls(["https://example.com/old"], {
    lookupHost: publicLookup,
    request: async (url) => {
      seen.push(url.toString());
      return url.pathname === "/old"
        ? { status: 302, location: "/current" }
        : { status: 200 };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.finalUrl, "https://example.com/current");
  assert.deepEqual(seen, ["https://example.com/old", "https://example.com/current"]);
});

test("stops evidence checks after the redirect limit", async () => {
  const [result] = await checkEvidenceUrls(["https://example.com/one"], {
    maxRedirects: 1,
    lookupHost: publicLookup,
    request: async () => ({ status: 302, location: "/again" }),
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "too_many_redirects");
});

test("marks timed-out evidence unavailable", async () => {
  const [result] = await checkEvidenceUrls(["https://example.com/slow"], {
    lookupHost: publicLookup,
    request: async () => { throw new Error("timeout"); },
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "timeout");
});

test("caches successful evidence longer than failed evidence and expires each result", async () => {
  let currentTime = 1_000;
  let successRequests = 0;
  let failureRequests = 0;
  const cache = new Map();
  const options = {
    cache,
    now: () => currentTime,
    successCacheMs: 1_000,
    failureCacheMs: 100,
    lookupHost: publicLookup,
    request: async (url: URL) => {
      if (url.pathname === "/available") {
        successRequests += 1;
        return { status: 200 };
      }
      failureRequests += 1;
      throw new Error("timeout");
    },
  };

  const urls = ["https://cache.example/available", "https://cache.example/slow"];
  const first = await checkEvidenceUrls(urls, options);
  const cached = await checkEvidenceUrls(urls, options);
  assert.deepEqual(cached, first);
  assert.equal(successRequests, 1);
  assert.equal(failureRequests, 1);
  assert.equal(cached[1].reason, "timeout");

  currentTime += 101;
  await checkEvidenceUrls(urls, options);
  assert.equal(successRequests, 1);
  assert.equal(failureRequests, 2);

  currentTime += 900;
  await checkEvidenceUrls(urls, options);
  assert.equal(successRequests, 2);
  assert.equal(failureRequests, 3);
});

test("revalidates cached redirect targets before returning evidence", async () => {
  let requests = 0;
  let redirectIsPrivate = false;
  const cache = new Map();
  const options = {
    cache,
    lookupHost: async (hostname: string) => redirectIsPrivate && hostname === "cdn.example"
      ? [{ address: "10.0.0.8", family: 4 }]
      : publicLookup(),
    request: async (url: URL) => {
      requests += 1;
      return url.hostname === "source.example"
        ? { status: 302, location: "https://cdn.example/report" }
        : { status: 200 };
    },
  };

  const [first] = await checkEvidenceUrls(["https://source.example/report"], options);
  assert.equal(first.finalUrl, "https://cdn.example/report");
  redirectIsPrivate = true;
  const [second] = await checkEvidenceUrls(["https://source.example/report"], options);
  assert.equal(second.available, false);
  assert.equal(second.reason, "blocked_destination");
  assert.equal(requests, 2);
});

test("blocks private and loopback destinations before requesting them", async () => {
  let requested = false;
  const results = await checkEvidenceUrls([
    "http://localhost/admin",
    "https://private.example/data",
    "http://169.254.169.254/latest/meta-data",
  ], {
    lookupHost: async (hostname) => hostname === "private.example"
      ? [{ address: "10.0.0.8", family: 4 }]
      : publicLookup(),
    request: async () => {
      requested = true;
      return { status: 200 };
    },
  });
  assert.equal(requested, false);
  assert.ok(results.every((result) => result.reason === "blocked_destination"));
});