// What an agent may read of the browser's traffic: cookies, tokens, passwords and card numbers are hidden by the
// field's name, by the value's shape and by values already known to be secret.

import { describe, expect, it } from "vitest";
import { HIDDEN, Secrets, hideBody, hideBodyValue, hideHeaders, hideUrl, learn, looksRandom, secretName } from "../server/traffic/redact.ts";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const SESSION = "s3ss10nV4lu3XyZ99aa";

describe("traffic redaction", () => {
  it("knows a secret field by its name, in any spelling", () => {
    for (const n of ["password", "Password", "new_password", "accessToken", "X-CSRF-Token", "x-api-key", "client_secret", "sessionId", "otp", "cvv", "cardNumber", "Authorization", "verification_code", "apiKey"]) {
      expect(secretName(n, "json"), n).toBe("always");
    }
    for (const n of ["author", "name", "country_code", "status", "keyboard", "pinned", "id", "price", "promo_code"]) {
      expect(secretName(n, "json"), n).toBeUndefined();
    }
    // A bare «code» is an OAuth code in an address and a status in JSON.
    expect(secretName("code", "query")).toBe("always");
    expect(secretName("code", "json")).toBe("weak");
    expect(secretName("key", "json")).toBe("weak");
  });

  it("tells a random token from a slug, a path, a UUID and a number", () => {
    expect(looksRandom("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b", 32)).toBe(true);
    expect(looksRandom("dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZTEyMw", 32)).toBe(true);
    expect(looksRandom("how-to-reset-a-router-in-five-easy-steps-2024", 32)).toBe(false);
    expect(looksRandom("/api/v1/users/1234567890/orders/list/of/all", 32)).toBe(false);
    expect(looksRandom("123e4567-e89b-12d3-a456-426614174000", 32)).toBe(false);
    expect(looksRandom("17000000001700000000170000000017", 32)).toBe(false);
  });

  it("hides cookies and credentials in headers and keeps the rest", () => {
    const s = new Secrets();
    const out = hideHeaders(
      [
        { name: "Cookie", value: `sid=${SESSION}; theme=dark` },
        { name: "Authorization", value: `Bearer ${JWT}` },
        { name: "X-CSRF-Token", value: "abc" },
        { name: "Set-Cookie", value: `sid=${SESSION}; Path=/; HttpOnly\nlang=ru; Path=/` },
        { name: "Content-Type", value: "application/json" },
        { name: "Accept-Language", value: "ru-RU,ru;q=0.9" },
      ],
      s,
    );
    expect(out).toEqual([
      { name: "Cookie", value: `sid=${HIDDEN}; theme=${HIDDEN}` },
      { name: "Authorization", value: `Bearer ${HIDDEN}` },
      { name: "X-CSRF-Token", value: HIDDEN },
      { name: "Set-Cookie", value: `sid=${HIDDEN}; Path=/; HttpOnly\nlang=${HIDDEN}; Path=/` },
      { name: "Content-Type", value: "application/json" },
      { name: "Accept-Language", value: "ru-RU,ru;q=0.9" },
    ]);
  });

  it("hides secret query parameters, user:password and a token in the fragment", () => {
    const s = new Secrets();
    expect(hideUrl("https://user:pw@shop.kz/cb?code=4f9a8c11&state=xyz&page=2&q=вода", s)).toBe(
      `https://shop.kz/cb?code=${HIDDEN}&state=xyz&page=2&q=${encodeURIComponent("вода")}`,
    );
    expect(hideUrl(`https://app.example/#access_token=${JWT}&expires_in=3600`, s)).toBe(`https://app.example/#access_token=${HIDDEN}&expires_in=3600`);
    expect(hideUrl("https://cdn.example/app.3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c.js", s)).toBe("https://cdn.example/app.3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c.js");
  });

  it("hides JSON fields by name, tokens and cards by shape, and leaves data alone", () => {
    const s = new Secrets();
    const body = JSON.stringify({
      user: { name: "Аня", email: "a@b.kz", password: "hunter2", id: "123e4567-e89b-12d3-a456-426614174000" },
      access_token: JWT,
      note: `use ${JWT} here`,
      card: "4111 1111 1111 1111",
      pan: 4111111111111111,
      items: [{ title: "Вода 19 л", price: 1200, code: "WATER_19" }],
      code: 200,
      blob: "dGhpcyBpcyBhIHNlY3JldCB0b2tlbiB2YWx1ZTEyMw",
      nested: JSON.stringify({ token: "abc", ok: true }),
      credentials: { login: "a", pass: "b" },
    });
    expect(hideBodyValue(body, "application/json", s)).toEqual({
      user: { name: "Аня", email: "a@b.kz", password: HIDDEN, id: "123e4567-e89b-12d3-a456-426614174000" },
      access_token: HIDDEN,
      note: `use ${HIDDEN} here`,
      card: HIDDEN,
      pan: HIDDEN,
      items: [{ title: "Вода 19 л", price: 1200, code: "WATER_19" }],
      code: 200,
      blob: HIDDEN,
      nested: JSON.stringify({ token: HIDDEN, ok: true }),
      credentials: HIDDEN,
    });
    expect(hideBody(body, "application/json", s)).not.toContain("hunter2");
  });

  it("hides form and multipart fields by name", () => {
    const s = new Secrets();
    expect(hideBody("username=anna&password=hunter2&remember=1", "application/x-www-form-urlencoded", s)).toBe(`username=anna&password=${HIDDEN}&remember=1`);
    const multipart = ["--XX", 'Content-Disposition: form-data; name="title"', "", "Отчёт", "--XX", 'Content-Disposition: form-data; name="token"', "", "abc123", "--XX", 'Content-Disposition: form-data; name="file"; filename="a.png"', "Content-Type: image/png", "", "PNGDATA", "--XX--", ""].join("\r\n");
    expect(hideBody(multipart, "multipart/form-data; boundary=XX", s)).toBe(`title: Отчёт\ntoken: ${HIDDEN}\nfile: file "a.png" (7 bytes)`);
  });

  it("hides what a page or a script spells out: filled-in fields and values assigned to secret names", () => {
    const s = new Secrets();
    const html = `<input name="username" value="anna"><input type="password" name="p" value="hunter2"><input type=hidden name=csrf_token value=abc123>
<script>window.cfg = { apiKey: "k-123", title: 'Shop', "session_id": "42", build: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b" }; var note = "it's fine";</script>`;
    expect(hideBody(html, "text/html", s)).toBe(
      `<input name="username" value="anna"><input type="password" name="p" value="${HIDDEN}"><input type=hidden name=csrf_token value=${HIDDEN}>
<script>window.cfg = { apiKey: "${HIDDEN}", title: 'Shop', "session_id": "${HIDDEN}", build: "${HIDDEN}" }; var note = "it's fine";</script>`,
    );
    // Seen once, they are hidden elsewhere too.
    learn(s, { body: `const refreshToken = "r3fr3sh-me-0nce";`, contentType: "text/javascript" });
    expect(hideUrl("https://shop.kz/x?next=r3fr3sh-me-0nce", s)).toBe(`https://shop.kz/x?next=${HIDDEN}`);
  });

  it("hides a value seen in a cookie or under a secret name wherever it shows up again", () => {
    const s = new Secrets();
    learn(s, { headers: [{ name: "Cookie", value: `sid=${SESSION}; theme=dark` }] });
    learn(s, { body: JSON.stringify({ data: { refresh_token: "r3fr3shT0kenValue" } }), contentType: "application/json" });
    learn(s, { url: "https://shop.kz/cb?code=0auThC0de77", headers: [{ name: "Authorization", value: "Bearer custom-opaque-credential-1" }] });
    expect(hideBody(`<script>window.__S = "${SESSION}"; var r = "r3fr3shT0kenValue";</script> theme dark`, "text/html", s)).toBe(
      `<script>window.__S = "${HIDDEN}"; var r = "${HIDDEN}";</script> theme dark`,
    );
    expect(hideUrl(`https://shop.kz/ws/${SESSION}/stream?x=0auThC0de77`, s)).toBe(`https://shop.kz/ws/${HIDDEN}/stream?x=${HIDDEN}`);
    expect(hideHeaders([{ name: "X-Trace", value: "custom-opaque-credential-1" }], s)).toEqual([{ name: "X-Trace", value: HIDDEN }]);
    // Short and plain values are not remembered: «dark» stays readable.
    expect(s.size).toBe(4);
  });
});
