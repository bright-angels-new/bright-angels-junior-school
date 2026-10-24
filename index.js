const JSON_HEADERS={
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const SESSION_SECONDS = 60 * 60 * 8;
const MAX_IMAGE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function htmlError(message, status = 400) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}

function randomHex(n = 32) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return b64url(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data)
    )
  );
}

async function signSession(env, payload) {
  const body = b64url(
    new TextEncoder().encode(JSON.stringify(payload))
  );

  return body + "." + await hmac(env.SESSION_SECRET, body);
}

async function verifySession(request, env) {
  if (!env.SESSION_SECRET || !env.ADMIN_EMAIL) return null;

  const cookieHeader = request.headers.get("Cookie") || "";

  const raw = cookieHeader
    .split(";")
    .map(x => x.trim())
    .find(x => x.startsWith("ba_admin="))
    ?.slice(9);

  if (!raw) return null;

  const [body, sig] = raw.split(".");
  if (!body || !sig) return null;

  const expected = await hmac(env.SESSION_SECRET, body);

  if (sig.length !== expected.length) return null;

  let diff = 0;

  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  if (diff) return null;

  try {
    const decoded = atob(
      body.replace(/-/g, "+").replace(/_/g, "/")
    );

    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(decoded, c => c.charCodeAt(0))
      )
    );

    if (
      payload.exp < Date.now() / 1000 ||
      payload.email !== env.ADMIN_EMAIL
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function cookie(value, maxAge) {
  return `ba_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function requireAdmin(request, env) {
  const session = await verifySession(request, env);

  if (!session) {
    return {
      error: json(
        { error: "Please sign in as the administrator." },
        401
      )
    };
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const csrf = request.headers.get("X-CSRF-Token");

    if (!csrf || csrf !== session.csrf) {
      return {
        error: json(
          {
            error:
              "Security check failed. Refresh the administrator session and try again."
          },
          403
        )
      };
    }
  }

  return { session };
}

function safeText(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

async function settings(env) {
  const { results = [] } = await env.DB
    .prepare("SELECT key,value FROM settings")
    .all();

  return Object.fromEntries(
    results.map(row => [row.key, row.value])
  );
}

async function listNews(env) {
  const { results = [] } = await env.DB
    .prepare(
      "SELECT id,title,body,date,created_at AS createdAt FROM announcements ORDER BY COALESCE(date,created_at) DESC,id DESC LIMIT 50"
    )
    .all();

  return results;
}

async function listGallery(env) {
  const { results = [] } = await env.DB
    .prepare(
      "SELECT id,object_key AS objectKey,caption,content_type AS contentType,created_at AS createdAt FROM gallery ORDER BY id DESC LIMIT 60"
    )
    .all();

  return results.map(item => ({
    ...item,
    url: null
  }));
}

async function listFeedback(env) {
  const { results = [] } = await env.DB
    .prepare(
      "SELECT id,parent_name AS parentName,email,phone,rating,message,created_at AS createdAt FROM feedback ORDER BY id DESC LIMIT 300"
    )
    .all();

  return results;
}

async function sendSchoolEmail(env, subject, textBody) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;

  try {
    const response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: ["brightangels26@gmail.com"],
          subject,
          text: textBody
        })
      }
    );

    if (!response.ok) {
      console.error(
        "Email provider returned",
        response.status,
        await response.text()
      );

      return false;
    }

    return true;
  } catch (error) {
    console.error("Email notification failed", error);
    return false;
  }
}

async function getApplications(env) {
  const { results = [] } = await env.DB
    .prepare(
      "SELECT id,reference,child_name AS childName,dob,gender,class_applying AS classApplying,previous_school AS previousSchool,guardian_name AS guardianName,relationship,phone,guardian_email AS guardianEmail,district,address,notes,passport_key AS passportKey,created_at AS createdAt FROM applications ORDER BY id DESC LIMIT 300"
    )
    .all();

  return results.map(item => ({
    ...item,
    passportUrl: null
  }));
}

async function apiRoute(request, env, url) {
  const path = url.pathname.replace(/^\/api/, "");

  if (path === "/public" && request.method === "GET") {
    return json({
      settings: await settings(env),
      news: await listNews(env),
      gallery: (await listGallery(env)).map(
        ({ id, caption, url, createdAt }) => ({
          id,
          caption,
          url,
          createdAt
        })
      )
    });
  }

  if (path === "/admissions" && request.method === "POST") {
    let form;

    try {
      form = await request.formData();
    } catch {
      return json(
        { error: "Invalid form submission." },
        400
      );
    }

    const child = safeText(form.get("childName"), 120);
    const dob = safeText(form.get("dob"), 20);
    const gender = safeText(form.get("gender"), 30);
    const cls = safeText(form.get("classApplying"), 60);
    const guardian = safeText(form.get("guardianName"), 120);
    const relationship = safeText(form.get("relationship"), 50);
    const phone = safeText(form.get("phone"), 40);
    const district = safeText(form.get("district"), 120);
    const address = safeText(form.get("address"), 500);

    if (
      !child ||
      !dob ||
      !gender ||
      !cls ||
      !guardian ||
      !relationship ||
      !phone ||
      !district ||
      !address
    ) {
      return json(
        { error: "Please complete all required fields." },
        400
      );
    }

    const reference =
      "BAJS-" +
      new Date().getFullYear() +
      "-" +
      randomHex(4).toUpperCase();

    await env.DB.prepare(
      "INSERT INTO applications (reference,child_name,dob,gender,class_applying,previous_school,guardian_name,relationship,phone,guardian_email,district,address,notes,passport_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        reference,
        child,
        dob,
        gender,
        cls,
        safeText(form.get("previousSchool"), 160),
        guardian,
        relationship,
        phone,
        safeText(form.get("guardianEmail"), 160),
        district,
        address,
        safeText(form.get("notes"), 1000),
        ""
      )
      .run();

    const emailSent = await sendSchoolEmail(
      env,
      `New admission application: ${reference}`,
      `A new admission application was received on the Bright Angels Junior School website.

Reference: ${reference}
Child: ${child}
Date of birth: ${dob}
Gender: ${gender}
Class applying for: ${cls}
Parent/guardian: ${guardian}
Phone: ${phone}
District: ${district}
Address: ${address}

Please sign in to the school administrator dashboard to review the application.`
    );

    return json(
      { ok: true, reference, emailSent },
      201
    );
  }

  if (path === "/feedback" && request.method === "POST") {
    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        { error: "Invalid feedback submission." },
        400
      );
    }

    const name = safeText(body.name, 120);
    const email = safeText(body.email, 160);
    const phone = safeText(body.phone, 40);
    const rating = safeText(body.rating, 30);
    const message = safeText(body.message, 2000);

    if (!name || !message) {
      return json(
        { error: "Please enter your name and message." },
        400
      );
    }

    if (message.length < 5) {
      return json(
        {
          error:
            "Please provide a little more detail in your message."
        },
        400
      );
    }

    await env.DB.prepare(
      "INSERT INTO feedback(parent_name,email,phone,rating,message) VALUES(?,?,?,?,?)"
    )
      .bind(name, email, phone, rating, message)
      .run();

    const emailSent = await sendSchoolEmail(
      env,
      "Website feedback from " + name,
      `New feedback received on the Bright Angels Junior School website.

Name: ${name}
Email: ${email || "Not supplied"}
Phone: ${phone || "Not supplied"}
Rating: ${rating || "Not supplied"}

Message:
${message}`
    );

    return json({ ok: true, emailSent }, 201);
  }

  if (
    path.startsWith("/gallery-image/") &&
    request.method === "GET"
  ) {
    return htmlError(
      "Gallery image storage is not configured.",
      404
    );
  }

  if (path === "/admin/login" && request.method === "POST") {
    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        { error: "Invalid login request." },
        400
      );
    }

    if (
      safeText(body.email, 320).toLowerCase() !==
        String(env.ADMIN_EMAIL || "").toLowerCase() ||
      !env.ADMIN_PASSWORD_HASH ||
      !body.password ||
      !env.SESSION_SECRET
    ) {
      return json(
        { error: "Invalid email or password." },
        401
      );
    }

    if (
      !await verifyPassword(
        body.password,
        env.ADMIN_PASSWORD_HASH
      )
    ) {
      return json(
        { error: "Invalid email or password." },
        401
      );
    }

    const csrf = randomHex(24);

    const value = await signSession(env, {
      email: env.ADMIN_EMAIL,
      csrf,
      exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
    });

    return json(
      { ok: true, csrf },
      200,
      { "set-cookie": cookie(value, SESSION_SECONDS) }
    );
  }

  if (path === "/admin/logout" && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;

    return json(
      { ok: true },
      200,
      { "set-cookie": cookie("", 0) }
    );
  }

  if (path.startsWith("/admin/") || path === "/admin/data") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;

    if (path === "/admin/data" && request.method === "GET") {
      return json({
        settings: await settings(env),
        news: await listNews(env),
        gallery: await listGallery(env),
        applications: await getApplications(env),
        feedback: await listFeedback(env)
      });
    }

    if (path === "/admin/settings" && request.method === "PUT") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid settings." }, 400);
      }

      const fields = [
        "headline",
        "welcome",
        "aboutText",
        "vision",
        "mission",
        "phone",
        "address"
      ];

      const statements = fields.map(key =>
        env.DB.prepare(
          "INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP"
        ).bind(
          key,
          safeText(
            body[key],
            key === "welcome" || key === "aboutText" ? 2000 : 1000
          )
        )
      );

      await env.DB.batch(statements);
      return json({ ok: true });
    }

    if (path === "/admin/news" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid announcement." }, 400);
      }

      const title = safeText(body.title, 150);
      const text = safeText(body.body, 2000);
      const date = safeText(body.date, 20);

      if (!title || !text) {
        return json(
          { error: "Title and announcement details are required." },
          400
        );
      }

      await env.DB.prepare(
        "INSERT INTO announcements(title,body,date) VALUES(?,?,?)"
      )
        .bind(title, text, date || null)
        .run();

      return json({ ok: true }, 201);
    }

    const deleteNews = path.match(/^\/admin\/news\/(\d+)$/);

    if (deleteNews && request.method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM announcements WHERE id=?"
      )
        .bind(Number(deleteNews[1]))
        .run();

      return json({ ok: true });
    }

    if (path === "/admin/gallery" && request.method === "POST") {
      return json(
        {
          error:
            "Gallery uploads are unavailable because image storage has not been configured."
        },
        503
      );
    }

    const deleteGallery = path.match(/^\/admin\/gallery\/(\d+)$/);

    if (deleteGallery && request.method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM gallery WHERE id=?"
      )
        .bind(Number(deleteGallery[1]))
        .run();

      return json({ ok: true });
    }

    const deleteFeedback = path.match(/^\/admin\/feedback\/(\d+)$/);

    if (deleteFeedback && request.method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM feedback WHERE id=?"
      )
        .bind(Number(deleteFeedback[1]))
        .run();

      return json({ ok: true });
    }

    const deleteApplication = path.match(/^\/admin\/admissions\/(\d+)$/);

    if (deleteApplication && request.method === "DELETE") {
      await env.DB.prepare(
        "DELETE FROM applications WHERE id=?"
      )
        .bind(Number(deleteApplication[1]))
        .run();

      return json({ ok: true });
    }

    const passport = path.match(/^\/admin\/passport\/(\d+)$/);

    if (passport && request.method === "GET") {
      return htmlError(
        "No passport photograph was saved for this application.",
        404
      );
    }
  }

  return json({ error: "Not found." }, 404);
}

async function verifyPassword(password, stored) {
  const [
    algorithm,
    iterationText,
    saltBase64,
    hashBase64
  ] = String(stored).split("$");

  if (algorithm !== "pbkdf2-sha256") return false;

  const iterations = Number(iterationText);

  if (
    !Number.isInteger(iterations) ||
    iterations < 100000 ||
    iterations > 2000000
  ) {
    return false;
  }

  try {
    const decode = value =>
      Uint8Array.from(
        atob(value),
        character => character.charCodeAt(0)
      );

    const salt = decode(saltBase64);
    const expected = decode(hashBase64);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const actual = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt,
          iterations,
          hash: "SHA-256"
        },
        key,
        expected.length * 8
      )
    );

    if (actual.length !== expected.length) return false;

    let diff = 0;

    for (let i = 0; i < actual.length; i++) {
      diff |= actual[i] ^ expected[i];
    }

    return diff === 0;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await apiRoute(request, env, url);
      } catch (error) {
        console.error("API error", error);

        return json(
          {
            error:
              "A server error occurred. Please try again later."
          },
          500
        );
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return htmlError("Static assets binding is missing.", 500);
  }
};
