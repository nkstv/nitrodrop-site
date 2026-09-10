export default {
  async fetch(request, env, ctx) {
    // CORS restreint : seul ton site peut appeler le worker (au lieu de "*").
    // Si ton admin/dashboard est sur un autre domaine, ajoute-le à cette liste.
    const ALLOWED_ORIGINS = ['https://drop-cash.com', 'https://www.drop-cash.com'];
    const reqOrigin = request.headers.get('Origin') || '';
    const allowOrigin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Key, Authorization',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ---------------------------------------------------------------
    // Rate limiting (10 requêtes / 10 s par joueur) sur les actions de jeu.
    // Défensif : si le binding RATE_LIMITER n'est pas configuré, on n'applique
    // simplement rien (le worker continue de fonctionner normalement).
    // La clé est le discordId AUTHENTIFIÉ (lu dans l'entête, sans toucher au body).
    // ---------------------------------------------------------------
    const RATE_LIMITED_PATHS = new Set([
      '/mines/start', '/mines/reveal', '/mines/cashout',
      '/blackjack/deal', '/blackjack/hit', '/blackjack/stand',
      '/blackjack/double', '/blackjack/insurance', '/blackjack/split',
      '/dice/roll', '/slots/spin',
      '/vault/attempt', '/drop/claim',
      '/profile/claim', '/profile/claim-achievements',
    ]);
    if (env.RATE_LIMITER && request.method === 'POST' && RATE_LIMITED_PATHS.has(url.pathname)) {
      const rlId = await authedDiscordId(request, env);
      if (rlId) {
        const { success } = await env.RATE_LIMITER.limit({ key: rlId });
        if (!success) {
          return new Response(JSON.stringify({ ok: false, reason: 'rate_limited' }),
            { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
    }

    // ---------------------------------------------------------------
    // POST /auth/session -> échange le token OAuth Discord contre un jeton
    // de session signé. C'est ce jeton (entête Bearer) qui authentifie
    // ensuite chaque action de joueur. L'identité n'est plus jamais tirée
    // d'un discordId envoyé par le navigateur.
    // ---------------------------------------------------------------
    if (url.pathname === '/auth/session' && request.method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const accessToken = String(body.accessToken || '').trim();
      if (!accessToken) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_token' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      let user;
      try {
        const r = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!r.ok) throw new Error('discord ' + r.status);
        user = await r.json();
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'invalid_token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const session = await createSessionToken(env, user.id, user.username);
      return new Response(JSON.stringify({ ok: true, session, discordId: user.id, username: user.username }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }


    // ---------------------------------------------------------------
    // GET /ticker/recent -> les dernières demandes de bonus RÉELLEMENT
    // envoyées (statut "sent"), pour le bandeau de preuve sociale de
    // l'accueil. Public, mais ne renvoie QUE pseudo/casino/date — jamais
    // l'email, l'IP, le Discord ID ou quoi que ce soit d'autre.
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // GET /kick/live-status?channels=a,b,c -> vérifie côté serveur (jamais
    // depuis le navigateur, pour éviter tout blocage CORS/anti-robot) quels
    // pseudos Kick sont actuellement en direct. Best-effort : si Kick refuse
    // ou bloque une requête, ce pseudo précis remonte juste à `null`
    // (statut inconnu) plutôt que de faire échouer toute la réponse — la
    // page qui appelle ça n'affiche alors simplement aucun badge pour lui.
    // ---------------------------------------------------------------
    if (url.pathname === '/kick/live-status' && request.method === 'GET') {
      const raw = url.searchParams.get('channels') || '';
      const channels = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
      const live = {};
      await Promise.all(channels.map(async (slug) => {
        try {
          const resp = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; DropCashBot/1.0; +https://drop-cash.com)',
              'Accept': 'application/json',
            },
          });
          if (!resp.ok) { live[slug] = null; return; }
          const data = await resp.json();
          live[slug] = !!(data && data.livestream);
        } catch (e) {
          live[slug] = null;
        }
      }));
      return new Response(JSON.stringify({ ok: true, live }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      });
    }

    if (url.pathname === '/ticker/recent' && request.method === 'GET') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ entries: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const all = await getAllSubmissions(env);
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 15, 30);
      const entries = all
        .filter(s => s.status === 'sent' && s.pseudo && s.platform)
        .sort((a, b) => (b.statusAt || b.dateMs || 0) - (a.statusAt || a.dateMs || 0))
        .slice(0, limit)
        .map(s => ({ pseudo: s.pseudo, platform: s.platform, dateMs: s.statusAt || s.dateMs || 0 }));
      return new Response(JSON.stringify({ entries }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /submissions -> liste toutes les demandes (protégé par clé)
    // ---------------------------------------------------------------
    if (url.pathname === '/submissions' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ submissions: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const all = await getAllSubmissions(env);
      return new Response(JSON.stringify({ submissions: all }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /submissions/tip -> coche/décoche "tipsé" pour une demande
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // POST /submissions/decline -> refuse une demande avec un motif (protégé)
    // Envoie un DM Discord expliquant la raison du refus.
    // ---------------------------------------------------------------
    if (url.pathname === '/submissions/decline' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const { id, reason, note } = body;
      if (!id || !reason) {
        return new Response('id ou motif manquant', { status: 400, headers: corsHeaders });
      }

      const declineReason = String(reason).slice(0, 40);
      const declineNote = String(note || '').slice(0, 300);
      let entry;
      if (env.VAULT_DB) {
        entry = await getSubmissionById(env, id);
        if (!entry) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
        await updateSubmission(env, id, {
          status: 'declined', statusAt: Date.now(), tipped: false, declineReason, declineNote,
        });
      } else {
        // Repli si D1 indisponible (comportement historique, sujet à la race condition connue)
        const all = await getAllSubmissions(env);
        entry = all.find(s => s.id === id);
        if (!entry) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
        entry.status = 'declined';
        entry.statusAt = Date.now();
        entry.tipped = false;
        entry.declineReason = declineReason;
        entry.declineNote = declineNote;
        await saveAllSubmissions(env, all);
      }

      // Message adapté au motif, comme convenu
      const head = `❌ Your bonus request for ${entry.platform} was declined.\n\n`;
      const foot = `\nIf you think this is a mistake, reach out to us on Discord.`;
      const messages = {
        duplicate_account:
          head +
          `Reason: **duplicate account detected**. Our partners only allow one account per person.\n` +
          foot,
        bonus_cashout:
          head +
          `Reason: **cashout of the welcome bonus**. Withdrawing your bonus straight away ` +
          `makes you ineligible for further offers.\n` +
          foot,
        all_in_bonus:
          head +
          `Reason: **all-in welcome bonus in one bet**, which makes you ineligible for the next reload.\n` +
          foot,
        no_deposit:
          head +
          `Reason: **no deposit made**. Please read the rules — you must make a deposit ` +
          `to claim this bonus.\n` +
          `You can try again once your deposit is done.`,
        discord_too_young:
          head +
          `Reason: **Discord account is not old enough**. This rule protects our offers ` +
          `from multi-accounting.\n` +
          foot,
        other:
          head +
          (entry.declineNote ? `Reason: ${entry.declineNote}\n` : '') +
          foot,
      };
      const message = messages[entry.declineReason] || messages.other;

      let discordResult = { attempted: false, ok: false, error: null };
      if (entry.discordId) {
        discordResult.attempted = true;
        try {
          await sendDiscordDM(entry.discordId, message, env);
          discordResult.ok = true;
        } catch (err) {
          discordResult.error = err.message;
        }
      }

      return new Response(JSON.stringify({ ok: true, discord: discordResult }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/submissions/tip' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const { id, tipped } = body;
      if (!id) {
        return new Response('id manquant', { status: 400, headers: corsHeaders });
      }

      let entry;
      const updateFields = {
        tipped: !!tipped,
        status: tipped ? 'sent' : 'pending',
        statusAt: Date.now(),
      };
      if (tipped) { updateFields.declineReason = ''; updateFields.declineNote = ''; }

      if (env.VAULT_DB) {
        entry = await getSubmissionById(env, id);
        if (!entry) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
        await updateSubmission(env, id, updateFields);
      } else {
        // Repli si D1 indisponible (comportement historique, sujet à la race condition connue)
        const all = await getAllSubmissions(env);
        entry = all.find(s => s.id === id);
        if (!entry) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
        Object.assign(entry, updateFields);
        await saveAllSubmissions(env, all);
      }
      Object.assign(entry, updateFields);

      let discordResult = { attempted: false, ok: false, error: null };
      // On envoie le DM uniquement quand on COCHE (pas quand on décoche), et si un ID Discord existe
      if (tipped && entry.discordId) {
        discordResult.attempted = true;
        try {
          const message =
            `🎉 Your bonus has just been sent!\n` +
            `Check your ${entry.platform} account. Good luck 🍀\n\n` +
            `Thanks for using our code, see you soon for more offers! 🎁`;
          await sendDiscordDM(entry.discordId, message, env);
          discordResult.ok = true;
        } catch (err) {
          discordResult.error = err.message;
        }
      }

      return new Response(JSON.stringify({ ok: true, discord: discordResult }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /submissions/archive -> archive/désarchive une demande
    // ---------------------------------------------------------------
    if (url.pathname === '/submissions/archive' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const { id, archived } = body;
      if (!id) {
        return new Response('id manquant', { status: 400, headers: corsHeaders });
      }
      if (env.VAULT_DB) {
        const entry = await getSubmissionById(env, id);
        if (!entry) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
        await updateSubmission(env, id, { archived: !!archived });
      } else {
        // Repli si D1 indisponible (comportement historique, sujet à la race condition connue)
        const all = await getAllSubmissions(env);
        const entry = all.find(s => s.id === id);
        if (!entry) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
        entry.archived = !!archived;
        await saveAllSubmissions(env, all);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /submissions/delete -> suppression DÉFINITIVE d'une demande (protégé)
    // Contrairement à l'archivage, ceci retire l'entrée du stockage partagé
    // (all_submissions) : elle disparaît donc aussi de la page Profil du
    // joueur (qui lit exactement la même liste), pas seulement du dashboard.
    // ---------------------------------------------------------------
    if (url.pathname === '/submissions/delete' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const { id } = body;
      if (!id) {
        return new Response('id manquant', { status: 400, headers: corsHeaders });
      }
      if (env.VAULT_DB) {
        const deleted = await deleteSubmissionById(env, id);
        if (!deleted) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
      } else {
        // Repli si D1 indisponible (comportement historique, sujet à la race condition connue)
        const all = await getAllSubmissions(env);
        const filtered = all.filter(s => s.id !== id);
        if (filtered.length === all.length) {
          return new Response('Introuvable', { status: 404, headers: corsHeaders });
        }
        await saveAllSubmissions(env, filtered);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /vault/status -> état public (juste "déjà réclamé ou non")
    // ---------------------------------------------------------------
    // =================================================================
    // DROPS — liens de récompense partagés sur Discord.
    // Chaque drop a un nombre de places limité ; un joueur ne peut le réclamer
    // qu'une seule fois. Les places sont décomptées via D1 pour garantir qu'on
    // ne distribue jamais plus que prévu, même si tout le monde clique en même
    // temps (KV seul laisserait passer des réclamations en trop).
    // =================================================================
    async function ensureDropTables(env) {
      await env.VAULT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS drops (
           id TEXT PRIMARY KEY,
           amount REAL NOT NULL,
           total_slots INTEGER NOT NULL,
           claimed_slots INTEGER NOT NULL DEFAULT 0,
           label TEXT,
           active INTEGER NOT NULL DEFAULT 1,
           created_at TEXT
         )`
      ).run();
      await env.VAULT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS drop_claims (
           drop_id TEXT NOT NULL,
           discord_id TEXT NOT NULL,
           claimed_at TEXT,
           PRIMARY KEY (drop_id, discord_id)
         )`
      ).run();
    }

    // ---------------------------------------------------------------
    // GET /drop/status?id=...&discordId=... -> état d'un drop (public)
    // ---------------------------------------------------------------
    if (url.pathname === '/drop/status' && request.method === 'GET') {
      const dropId = (url.searchParams.get('id') || '').trim();
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.VAULT_DB || !dropId) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureDropTables(env);
      const drop = await env.VAULT_DB.prepare(
        `SELECT * FROM drops WHERE id = ?`
      ).bind(dropId).first();

      if (!drop) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let alreadyClaimed = false;
      if (discordId) {
        const row = await env.VAULT_DB.prepare(
          `SELECT 1 FROM drop_claims WHERE drop_id = ? AND discord_id = ?`
        ).bind(dropId, discordId).first();
        alreadyClaimed = !!row;
      }

      return new Response(JSON.stringify({
        ok: true,
        drop: {
          id: drop.id,
          amount: drop.amount,
          label: drop.label || '',
          totalSlots: drop.total_slots,
          claimedSlots: drop.claimed_slots,
          remaining: Math.max(0, drop.total_slots - drop.claimed_slots),
          active: !!drop.active,
        },
        alreadyClaimed,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---------------------------------------------------------------
    // POST /drop/claim -> réclame une place (public, connexion Discord requise)
    // ---------------------------------------------------------------
    if (url.pathname === '/drop/claim' && request.method === 'POST') {
      if (!env.VAULT_DB || !env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const dropId = String(body.id || '').trim();
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const pseudo = String(body.pseudo || '').trim().slice(0, 60);
      const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 300);

      // Sans identification, n'importe qui pourrait vider le drop en rechargeant
      if (!dropId || !discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_discord' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await ensureDropTables(env);

      const userEntry = await touchUserDirectory(env, discordId, pseudo, avatarUrl);
      if (userEntry.banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const drop = await env.VAULT_DB.prepare(`SELECT * FROM drops WHERE id = ?`).bind(dropId).first();
      if (!drop) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!drop.active) {
        return new Response(JSON.stringify({ ok: false, reason: 'inactive' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Réservation de la place : la condition sur claimed_slots est évaluée par
      // D1 de façon atomique, donc deux joueurs ne peuvent pas prendre la même.
      const claimedAt = new Date().toISOString();
      const reserve = await env.VAULT_DB.prepare(
        `UPDATE drops SET claimed_slots = claimed_slots + 1
         WHERE id = ? AND active = 1 AND claimed_slots < total_slots
           AND NOT EXISTS (SELECT 1 FROM drop_claims WHERE drop_id = ? AND discord_id = ?)`
      ).bind(dropId, dropId, discordId).run();

      if (!reserve.meta || reserve.meta.changes === 0) {
        // Soit le joueur a déjà réclamé, soit il n'y a plus de place
        const already = await env.VAULT_DB.prepare(
          `SELECT 1 FROM drop_claims WHERE drop_id = ? AND discord_id = ?`
        ).bind(dropId, discordId).first();
        return new Response(JSON.stringify({
          ok: false,
          reason: already ? 'already_claimed' : 'no_slots_left',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // Trace de la réclamation (la clé primaire empêche tout doublon)
      try {
        await env.VAULT_DB.prepare(
          `INSERT INTO drop_claims (drop_id, discord_id, claimed_at) VALUES (?, ?, ?)`
        ).bind(dropId, discordId, claimedAt).run();
      } catch (e) {
        // Doublon détecté après coup : on rend la place réservée
        await env.VAULT_DB.prepare(
          `UPDATE drops SET claimed_slots = claimed_slots - 1 WHERE id = ?`
        ).bind(dropId).run();
        return new Response(JSON.stringify({ ok: false, reason: 'already_claimed' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const keysConfig = await getKeysConfig(env);
      const balance = await getKeysBalance(env, discordId, keysConfig);
      const amount = roundKeys(parseFloat(drop.amount) || 0);
      balance.keys = roundKeys((balance.keys || 0) + amount);
      await saveKeysBalance(env, discordId, balance);

      const fresh = await env.VAULT_DB.prepare(`SELECT claimed_slots, total_slots FROM drops WHERE id = ?`).bind(dropId).first();

      return new Response(JSON.stringify({
        ok: true,
        amount,
        keys: balance.keys,
        remaining: fresh ? Math.max(0, fresh.total_slots - fresh.claimed_slots) : 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---------------------------------------------------------------
    // Gestion des drops depuis /admin (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/drop/admin/list' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ drops: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      await ensureDropTables(env);
      const rows = await env.VAULT_DB.prepare(
        `SELECT * FROM drops ORDER BY created_at DESC LIMIT 30`
      ).all();
      const drops = (rows.results || []).map(d => ({
        id: d.id,
        amount: d.amount,
        label: d.label || '',
        totalSlots: d.total_slots,
        claimedSlots: d.claimed_slots,
        remaining: Math.max(0, d.total_slots - d.claimed_slots),
        active: !!d.active,
        createdAt: d.created_at,
      }));
      return new Response(JSON.stringify({ drops }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/drop/admin/create' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response('Base D1 non configurée', { status: 500, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const amount = parseFloat(body.amount);
      const slots = parseInt(body.slots, 10);
      const label = String(body.label || '').slice(0, 80);
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(slots) || slots <= 0) {
        return new Response('Montant ou nombre de places invalide', { status: 400, headers: corsHeaders });
      }

      await ensureDropTables(env);
      // Identifiant court et lisible, suffisant car non devinable en pratique
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      await env.VAULT_DB.prepare(
        `INSERT INTO drops (id, amount, total_slots, claimed_slots, label, active, created_at)
         VALUES (?, ?, ?, 0, ?, 1, ?)`
      ).bind(id, roundKeys(amount), slots, label, new Date().toISOString()).run();

      return new Response(JSON.stringify({ ok: true, id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/drop/admin/toggle' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const id = String(body.id || '').trim();
      const active = body.active ? 1 : 0;
      if (!id) return new Response('id manquant', { status: 400, headers: corsHeaders });
      await ensureDropTables(env);
      await env.VAULT_DB.prepare(`UPDATE drops SET active = ? WHERE id = ?`).bind(active, id).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/vault/status' && request.method === 'GET') {
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ claimed: false }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const round = await getVaultRound(env);
      return new Response(JSON.stringify({ claimed: !!(round && round.claimed) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /vault/attempt -> un visiteur tente un code (public)
    // ---------------------------------------------------------------
    if (url.pathname === '/vault/attempt' && request.method === 'POST') {
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const attemptCodeRaw = String(body.code || '').trim();
      const username = String(body.username || '').trim().slice(0, 40);
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 300);
      // La connexion Discord est obligatoire : le gain est crédité en clés sur le
      // compte du joueur, il faut donc un identifiant fiable (un pseudo tapé à la
      // main serait usurpable et ne permettrait pas de créditer le bon compte).
      if (!username || !discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_discord' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const vaultUserEntry = await touchUserDirectory(env, discordId, username, avatarUrl);
      if (vaultUserEntry.banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const round = await getVaultRound(env);
      if (!round || !round.code) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (round.claimed) {
        return new Response(JSON.stringify({ ok: false, reason: 'already_claimed' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Suivi du nombre de participants uniques (par IP) sur ce round (informatif, pas critique)
      const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
      const attemptedIps = await addVaultParticipant(env, ip);

      // Tentative ATOMIQUE : cette requête SQL ne peut réussir que si personne d'autre
      // n'a déjà réclamé le coffre ET que le code correspond. D1 (SQLite) garantit
      // qu'une seule requête concurrente peut satisfaire "claimed = 0" à la fois,
      // contrairement à l'ancien système KV qui pouvait laisser passer 2 gagnants
      // en cas de tentatives quasi simultanées depuis des régions différentes.
      const claimedAt = new Date().toISOString();
      const result = await env.VAULT_DB.prepare(
        `UPDATE vault_round
         SET claimed = 1, claimed_at = ?, claimed_ip = ?, claimed_username = ?
         WHERE id = 1 AND claimed = 0 AND LOWER(TRIM(code)) = LOWER(TRIM(?))`
      ).bind(claimedAt, ip, username, attemptCodeRaw).run();

      if (!result.meta || result.meta.changes === 0) {
        // Soit le code est faux, soit quelqu'un d'autre vient de réclamer le coffre
        // à l'instant : on relit l'état réel pour donner le bon message.
        const fresh = await getVaultRound(env);
        if (fresh && fresh.claimed) {
          return new Response(JSON.stringify({ ok: false, reason: 'already_claimed' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: false, reason: 'wrong_code' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Crédite le gain en clés sur le compte du joueur (même monnaie que les mini-jeux)
      const keysWon = roundKeys(parseFloat(round.amount) || 0);
      let newBalance = null;
      if (keysWon > 0 && env.SUBMISSIONS) {
        const keysConfig = await getKeysConfig(env);
        const balance = await getKeysBalance(env, discordId, keysConfig);
        balance.keys = roundKeys(balance.keys + keysWon);
        await saveKeysBalance(env, discordId, balance);
        newBalance = balance.keys;
      }

      await addVaultHistoryEntry(env, {
        username, discordId, avatarUrl,
        amount: keysWon, code: round.code || '', claimedAt,
        participants: attemptedIps.length,
      });

      return new Response(JSON.stringify({ ok: true, amount: keysWon, keys: newBalance }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /vault/history -> historique public des gains (pseudo + montant + date, jamais l'IP)
    // ---------------------------------------------------------------
    if (url.pathname === '/vault/history' && request.method === 'GET') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ history: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const history = await getVaultHistory(env);
      return new Response(JSON.stringify({ history: history.slice().reverse() }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /vault/admin-state -> code/montant/état actuels (protégé, pour préremplir l'admin)
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // POST /vault/reset-history -> vide l'historique des gains du coffre (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/vault/reset-history' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await env.SUBMISSIONS.put('vault_history', JSON.stringify([]));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/vault/admin-state' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const round = await getVaultRound(env);
      const attemptedIps = await getVaultParticipants(env);
      return new Response(JSON.stringify({
        code: round ? round.code : '',
        amount: round ? round.amount : '',
        claimed: !!(round && round.claimed),
        claimedAt: round ? round.claimed_at : null,
        claimedIp: round ? round.claimed_ip : null,
        username: round ? round.claimed_username : null,
        attemptedIps,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }














    // ---------------------------------------------------------------
    // POST /vault/history/clear -> vide l'historique des gains (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/vault/history/clear' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      await env.SUBMISSIONS.delete('vault_history');
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /affiliates/import -> importe/remplace l'export CSV d'un casino (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/affiliates/import' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const casino = String(body.casino || '').trim();
      const players = Array.isArray(body.players) ? body.players : [];
      if (!casino || players.length === 0) {
        return new Response('Casino ou joueurs manquants', { status: 400, headers: corsHeaders });
      }
      const slug = slugifyCasino(casino);
      const cleanPlayers = players.map(p => ({
        pseudo: String(p.pseudo || '').trim(),
        totalEarned: typeof p.totalEarned === 'number' ? p.totalEarned : parseFloat(p.totalEarned) || 0,
        joined: String(p.joined || '').trim(),
        wagered: typeof p.wagered === 'number' ? p.wagered : parseFloat(p.wagered) || 0,
      })).filter(p => p.pseudo);

      const importedAt = new Date().toISOString();
      await env.SUBMISSIONS.put(`affiliates_data_${slug}`, JSON.stringify({
        displayName: casino,
        importedAt,
        players: cleanPlayers,
      }));

      const casinosRaw = await env.SUBMISSIONS.get('affiliates_casinos');
      const casinos = casinosRaw ? JSON.parse(casinosRaw) : [];
      const totalEarned = cleanPlayers.reduce((sum, p) => sum + (p.totalEarned || 0), 0);
      const existingIdx = casinos.findIndex(c => c.slug === slug);
      const entry = { slug, displayName: casino, importedAt, count: cleanPlayers.length, totalEarned };
      if (existingIdx >= 0) casinos[existingIdx] = entry;
      else casinos.push(entry);
      await env.SUBMISSIONS.put('affiliates_casinos', JSON.stringify(casinos));

      return new Response(JSON.stringify({ ok: true, slug, count: cleanPlayers.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /affiliates/delete -> supprime les données importées d'un casino (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/affiliates/delete' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const slug = String(body.slug || '').trim();
      if (!slug) {
        return new Response('Slug manquant', { status: 400, headers: corsHeaders });
      }
      await env.SUBMISSIONS.delete(`affiliates_data_${slug}`);
      const casinosRaw = await env.SUBMISSIONS.get('affiliates_casinos');
      const casinos = casinosRaw ? JSON.parse(casinosRaw) : [];
      const updated = casinos.filter(c => c.slug !== slug);
      await env.SUBMISSIONS.put('affiliates_casinos', JSON.stringify(updated));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /affiliates/casinos -> liste des casinos importés avec leurs stats (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/affiliates/casinos' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const casinosRaw = await env.SUBMISSIONS.get('affiliates_casinos');
      const casinos = casinosRaw ? JSON.parse(casinosRaw) : [];
      return new Response(JSON.stringify({ casinos }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /affiliates/data?casino=<slug> -> liste des joueurs importés pour un casino (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/affiliates/data' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const slug = url.searchParams.get('casino') || '';
      if (!slug) {
        return new Response(JSON.stringify({ displayName: '', importedAt: null, players: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const raw = await env.SUBMISSIONS.get(`affiliates_data_${slug}`);
      const data = raw ? JSON.parse(raw) : { displayName: '', importedAt: null, players: [] };
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /tips/import -> importe/remplace l'export CSV des tips reçus (protégé)
    // Contrairement aux affiliés, pas de notion de casino ici : un seul jeu de
    // données global (le "Receiver" du CSV Duel.com est croisé sur le pseudo,
    // remplace la colonne "Qualifié" du tableau des demandes de bonus).
    // ---------------------------------------------------------------
    if (url.pathname === '/tips/import' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const tips = Array.isArray(body.tips) ? body.tips : [];
      if (tips.length === 0) {
        return new Response('Aucune ligne à importer', { status: 400, headers: corsHeaders });
      }
      const cleanTips = tips.map(t => ({
        pseudo: String(t.pseudo || '').trim(),
        totalTipped: typeof t.totalTipped === 'number' ? t.totalTipped : parseFloat(t.totalTipped) || 0,
        numberOfTips: typeof t.numberOfTips === 'number' ? t.numberOfTips : parseInt(t.numberOfTips, 10) || 0,
      })).filter(t => t.pseudo);

      const importedAt = new Date().toISOString();
      await env.SUBMISSIONS.put('tips_data', JSON.stringify({ importedAt, tips: cleanTips }));

      return new Response(JSON.stringify({ ok: true, count: cleanTips.length, importedAt }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /tips/data -> jeu de données tips actuellement importé (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/tips/data' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const raw = await env.SUBMISSIONS.get('tips_data');
      const data = raw ? JSON.parse(raw) : { importedAt: null, tips: [] };
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /bonus-limits -> limites configurées, par casino (public : ce sont
    // juste des nombres, pas de donnée sensible, utile pour griser les
    // boutons côté site avant même de connaître l'identité du joueur)
    // ---------------------------------------------------------------
    if (url.pathname === '/bonus-limits' && request.method === 'GET') {
      const limits = await getBonusLimits(env);
      return new Response(JSON.stringify({ ok: true, limits }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /bonus-limits/set -> remplace la liste complète des limites (protégé)
    // Body: { limits: { "Duel.com": 1, "Rainbet.com": 2, ... } } — 0 ou absent
    // = illimité pour ce casino.
    // ---------------------------------------------------------------
    if (url.pathname === '/bonus-limits/set' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const limits = (body && typeof body.limits === 'object' && body.limits) ? body.limits : {};
      const clean = {};
      for (const [platform, max] of Object.entries(limits)) {
        const n = parseInt(max, 10);
        if (Number.isFinite(n) && n > 0) clean[platform] = n;
      }
      await env.SUBMISSIONS.put('bonus_submission_limits', JSON.stringify(clean));
      return new Response(JSON.stringify({ ok: true, limits: clean }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /bonus-limits/status?discordId=... -> pour CE joueur, où en est-il
    // par rapport à la limite de chaque casino (public : seulement le
    // décompte du joueur qui appelle, avec son propre discordId).
    // ---------------------------------------------------------------
    if (url.pathname === '/bonus-limits/status' && request.method === 'GET') {
      const discordId = (url.searchParams.get('discordId') || '').trim();
      if (!discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_discord_id' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const limits = await getBonusLimits(env);
      const all = await getAllSubmissions(env);
      const counts = {};
      const lastRequestAt = {};
      for (const entry of all) {
        if (entry.discordId !== discordId) continue;
        counts[entry.platform] = (counts[entry.platform] || 0) + 1;
        if (typeof entry.dateMs === 'number' && (!lastRequestAt[entry.platform] || entry.dateMs > lastRequestAt[entry.platform])) {
          lastRequestAt[entry.platform] = entry.dateMs;
        }
      }
      // Cooldown de 24h entre deux demandes pour une MÊME offre (indépendant de
      // la limite totale ci-dessus) — même règle que la vérification faite au
      // moment de l'envoi, ici juste pour l'afficher à l'avance sur le bouton.
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const status = {};
      for (const platform of new Set([...Object.keys(limits), ...Object.keys(counts)])) {
        const limit = limits[platform] || 0;
        const count = counts[platform] || 0;
        const last = lastRequestAt[platform];
        const msSinceLast = typeof last === 'number' ? (nowMs - last) : Infinity;
        const onCooldown = msSinceLast < TWENTY_FOUR_HOURS_MS;
        const hoursRemaining = onCooldown ? Math.max(1, Math.ceil((TWENTY_FOUR_HOURS_MS - msSinceLast) / (60 * 60 * 1000))) : 0;
        status[platform] = { count, limit, reached: limit > 0 && count >= limit, onCooldown, hoursRemaining };
      }
      return new Response(JSON.stringify({ ok: true, status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }







    // ---------------------------------------------------------------
    // POST /vault/set -> définit un nouveau code/montant et relance un round (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/vault/set' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const { code, amount, discordMessage } = body;
      if (!code) {
        return new Response('Code manquant', { status: 400, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response('Base D1 non configurée (binding VAULT_DB manquant sur le Worker)', { status: 500, headers: corsHeaders });
      }
      await env.VAULT_DB.prepare(
        `INSERT INTO vault_round (id, code, amount, claimed, claimed_at, claimed_ip, claimed_username)
         VALUES (1, ?, ?, 0, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code,
           amount = excluded.amount,
           claimed = 0,
           claimed_at = NULL,
           claimed_ip = NULL,
           claimed_username = NULL`
      ).bind(String(code).trim(), String(amount || '').trim()).run();
      await resetVaultParticipants(env);

      let discordResult = { attempted: false, ok: false, error: null };
      if (env.DISCORD_VAULT_WEBHOOK_URL && discordMessage) {
        discordResult.attempted = true;
        try {
          const text = String(discordMessage)
            .replaceAll('{code}', String(code).trim())
            .replaceAll('{amount}', String(amount || '').trim());
          const webhookResp = await fetch(env.DISCORD_VAULT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text }),
          });
          if (!webhookResp.ok) {
            throw new Error(`Webhook Discord a répondu ${webhookResp.status}`);
          }
          discordResult.ok = true;
        } catch (err) {
          discordResult.error = err.message;
        }
      }

      return new Response(JSON.stringify({ ok: true, discord: discordResult }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // =================================================================
    // MINES — jeu à clés (2/jour par défaut, cumulables), positions des
    // bombes générées et gardées côté serveur uniquement (jamais envoyées
    // au client), pour qu'il soit impossible de tricher en lisant le code.
    // =================================================================
    const MINES_TILE_COUNT = 25;
    const MINES_BOMB_COUNT_DEFAULT = 5;
    const MINES_ALLOWED_BOMB_COUNTS = [3, 5, 10]; // Low / Medium / High
    const MINES_HOUSE_EDGE = 0.96;

    // Multiplicateur "juste" (calcul combinatoire) pour k cases sûres révélées
    // d'affilée sur un plateau de T cases avec M bombes, avec une marge de la
    // maison de 4% (comme la plupart des jeux Mines) appliquée dessus.
    function minesMultiplierForStep(step, mineCount) {
      const M = MINES_ALLOWED_BOMB_COUNTS.includes(mineCount) ? mineCount : MINES_BOMB_COUNT_DEFAULT;
      const T = MINES_TILE_COUNT;
      let fair = 1;
      for (let i = 0; i <= step; i++) {
        fair *= (T - i) / (T - M - i);
      }
      return Math.round(fair * MINES_HOUSE_EDGE * 100) / 100;
    }

    // Mise minimum. Les gains produisent des décimales (multiplicateurs 1.20×,
    // 2.94×...), donc un joueur peut se retrouver avec 0.80 clé : imposer un
    // minimum de 1 rendrait ce solde inutilisable et le bloquerait.
    const MIN_BET_KEYS = 0.1;

    // Arrondit à 2 décimales pour éviter les problèmes de virgule flottante,
    // sans jamais arrondir à l'entier le plus proche (les clés peuvent être décimales).
    function roundKeys(n) {
      return Math.round(n * 100) / 100;
    }

    // ---- Système de "clés" partagé entre tous les mini-jeux (Mines, Blackjack, ...) ----
    async function getKeysConfig(env) {
      if (!env.SUBMISSIONS) return { dailyKeys: 2 };
      const raw = await env.SUBMISSIONS.get('mines_config');
      const config = raw ? JSON.parse(raw) : {};
      if (typeof config.dailyKeys !== 'number') config.dailyKeys = 2;
      return config;
    }

    // Lit le solde de clés d'un joueur, en appliquant le versement quotidien
    // si ce n'est pas déjà fait pour aujourd'hui (les clés non utilisées s'accumulent).
    // Le versement quotidien n'est plus automatique : le joueur doit le réclamer
    // depuis sa page Profil (route /profile/claim). Cette fonction se contente
    // donc de lire le solde, sans jamais le créditer au passage.
    async function getKeysBalance(env, discordId, config) {
      const raw = await env.SUBMISSIONS.get(`mines_balance_${discordId}`);
      return raw ? JSON.parse(raw) : { keys: 0, lastTopUp: null, streak: 0 };
    }

    // Cloudflare limite les écritures répétées sur une MÊME clé (~1/seconde).
    // Un joueur qui enchaîne très vite (ou joue depuis deux onglets) peut donc
    // se voir refuser l'écriture de son solde avec une erreur 429.
    // On réessaie brièvement : la collision dure rarement plus de quelques
    // centaines de millisecondes. Si ça échoue quand même, l'erreur remonte —
    // le solde ne doit JAMAIS être perdu silencieusement.
    async function saveKeysBalance(env, discordId, balance) {
      const key = `mines_balance_${discordId}`;
      const payload = JSON.stringify(balance);
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await env.SUBMISSIONS.put(key, payload);
          return;
        } catch (e) {
          lastError = e;
          const isRateLimit = String(e && e.message || '').includes('429');
          if (!isRateLimit) throw e;
          // Attente croissante avant de retenter : 350ms puis 700ms
          await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
        }
      }
      throw lastError;
    }

    // ---- Annuaire des joueurs (pour l'onglet Utilisateurs du dashboard) ----
    async function getUserDirectory(env) {
      const raw = await env.SUBMISSIONS.get('user_directory');
      return raw ? JSON.parse(raw) : {};
    }

    async function touchUserDirectory(env, discordId, pseudo, avatarUrl) {
      const dir = await getUserDirectory(env);
      const existing = dir[discordId];
      const now = Date.now();
      // On n'écrit que si c'est un nouveau joueur, si le pseudo/avatar a changé, ou si
      // ça fait plus de 5 minutes depuis la dernière mise à jour — sinon cette fonction
      // réécrivait l'annuaire ENTIER (tous les joueurs) à chaque mise sur chaque jeu,
      // ce qui épuisait le quota d'écritures KV en quelques dizaines de parties.
      const needsWrite = !existing
        || existing.pseudo !== pseudo
        || (avatarUrl && existing.avatarUrl !== avatarUrl)
        || (now - (existing.lastSeen || 0)) > 5 * 60 * 1000;

      const updated = {
        pseudo: pseudo || (existing && existing.pseudo) || '',
        avatarUrl: avatarUrl || (existing && existing.avatarUrl) || '',
        lastSeen: needsWrite ? now : (existing ? existing.lastSeen : now),
        banned: existing ? !!existing.banned : false,
      };

      if (needsWrite) {
        dir[discordId] = updated;
        // Clé partagée par tous les joueurs : une écriture concurrente peut être
        // rejetée. L'annuaire n'est qu'informatif, on ne bloque pas la partie.
        try {
          await env.SUBMISSIONS.put('user_directory', JSON.stringify(dir));
        } catch (e) {
          console.warn('Annuaire non mis à jour (écritures concurrentes) :', e.message);
        }
      }
      return updated;
    }

    // ---- Corrections manuelles du total misé (onglet Leaderboard du dashboard) ----
    // Stockées à part de l'historique des parties : corriger le classement d'un
    // joueur ne supprime jamais ses parties, qui restent consultables.
    async function getWagerAdjustments(env) {
      const raw = await env.SUBMISSIONS.get('wager_adjustments');
      return raw ? JSON.parse(raw) : {};
    }

    async function saveWagerAdjustments(env, adjustments) {
      await env.SUBMISSIONS.put('wager_adjustments', JSON.stringify(adjustments));
    }

    // ---- Historique des parties (mines/blackjack/dice/slots) ----
    // Dernier des trois blobs KV partagés du site à encore utiliser le schéma
    // "tout relire -> modifier -> tout réécrire" — et de loin le plus sollicité :
    // une écriture à CHAQUE partie, sur les 4 jeux, par tous les joueurs en
    // simultané. Migré vers D1 (une ligne par partie, comme "submissions") :
    // un simple INSERT ne peut jamais écraser la partie d'un autre joueur, et
    // il n'y a plus de troncature aux 1000 dernières (partagée entre TOUS les
    // joueurs) qui faisait disparaître silencieusement l'historique ancien
    // d'un joueur actif — la cause des soucis de succès et de stats qu'on a
    // corrigés au cas par cas jusqu'ici.
    async function ensureGamePlaysTable(env) {
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS game_plays (
          id TEXT PRIMARY KEY,
          game TEXT,
          discordId TEXT,
          dateMs INTEGER,
          data TEXT
        )
      `).run();
      await env.VAULT_DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_game_plays_game_discord ON game_plays (game, discordId)
      `).run();
    }

    const GAME_PLAY_KV_KEYS = { mines: 'mines_plays', blackjack: 'blackjack_plays', dice: 'dice_plays', slots: 'slots_plays' };

    // Renvoie TOUTES les parties d'un jeu, du plus ancien au plus récent — le
    // même format qu'avant (un tableau), pour que le reste du code n'ait rien
    // à changer. D1 tant qu'elle contient des données, sinon repli sur
    // l'ancien blob KV (tant que /admin/migrate-game-plays-to-d1 n'a pas
    // encore été lancé, ou si D1 est indisponible).
    async function getGamePlays(env, game) {
      if (env.VAULT_DB) {
        try {
          await ensureGamePlaysTable(env);
          const { results } = await env.VAULT_DB.prepare(
            'SELECT data FROM game_plays WHERE game = ? ORDER BY dateMs ASC'
          ).bind(game).all();
          if (results && results.length > 0) {
            return results.map(r => JSON.parse(r.data));
          }
        } catch (e) {
          console.warn(`Lecture D1 des parties (${game}) échouée, repli KV :`, e.message);
        }
      }
      if (!env.SUBMISSIONS) return [];
      const raw = await env.SUBMISSIONS.get(GAME_PLAY_KV_KEYS[game] || game);
      return raw ? JSON.parse(raw) : [];
    }

    // Variante ciblée sur UN joueur : exploite l'index (game, discordId) au
    // lieu de rapatrier l'historique de tout le monde pour filtrer ensuite en
    // JS. Utilisée par la page Profil et les succès, qui n'ont besoin que des
    // parties d'une seule personne.
    // Note : un résultat vide pour CE joueur ne veut pas forcément dire "pas
    // encore migré" (un joueur peut juste n'avoir aucune partie sur ce jeu) —
    // on vérifie donc d'abord si la table contient des données pour ce jeu en
    // général avant de décider si on lui fait confiance.
    async function getGamePlaysByPlayer(env, game, discordId) {
      if (!discordId) return [];
      if (env.VAULT_DB) {
        try {
          await ensureGamePlaysTable(env);
          const probe = await env.VAULT_DB.prepare(
            'SELECT 1 FROM game_plays WHERE game = ? LIMIT 1'
          ).bind(game).first();
          if (probe) {
            const { results } = await env.VAULT_DB.prepare(
              'SELECT data FROM game_plays WHERE game = ? AND discordId = ? ORDER BY dateMs ASC'
            ).bind(game, discordId).all();
            return (results || []).map(r => JSON.parse(r.data));
          }
        } catch (e) {
          console.warn(`Lecture D1 des parties (${game}) pour un joueur échouée, repli KV :`, e.message);
        }
      }
      const all = await getGamePlays(env, game);
      return all.filter(p => p.discordId === discordId);
    }

    // Enregistre UNE partie (un INSERT, jamais un re-write du tableau entier).
    async function insertGamePlay(env, game, entry) {
      await ensureGamePlaysTable(env);
      await env.VAULT_DB.prepare(
        'INSERT OR IGNORE INTO game_plays (id, game, discordId, dateMs, data) VALUES (?, ?, ?, ?, ?)'
      ).bind(entry.id, game, entry.discordId || '', entry.dateMs || Date.now(), JSON.stringify(entry)).run();
    }


    // Les logs mines_plays/blackjack_plays/dice_plays/slots_plays sont tronqués
    // aux 1000 dernières parties (voir addMinesPlay etc.) : recalculer une
    // statistique en sommant ces logs fait donc disparaître silencieusement
    // les parties les plus anciennes d'un joueur actif, et le "à vie" ment —
    // que ce soit sur le leaderboard OU sur la page Profil.
    // Cette table-ci n'est jamais tronquée : chaque partie l'incrémente une
    // fois (voir addLifetimeWager, appelé depuis chaque addXxxPlay) et sert de
    // seule source de vérité pour /leaderboard, /leaderboard/admin et
    // /profile/summary.
    //
    // SUR D1 (comme "submissions") : un seul blob KV relu-modifié-réécrit à
    // CHAQUE partie de mines/blackjack/dice/slot, par tous les joueurs en
    // simultané, est le pire cas de course possible sur tout le site. D1
    // permet un vrai UPSERT atomique en une seule instruction SQL : impossible
    // que deux parties terminées au même instant s'écrasent l'une l'autre.
    // ---- Série de connexion quotidienne (streak), classable ----
    // Le solde/streak par joueur vit dans une clé KV individuelle
    // (mines_balance_<id>) — parfait pour lire/écrire UN joueur, mais
    // impossible à trier efficacement pour un classement (il faudrait lister
    // puis lire des centaines de clés une par une à chaque affichage). Cette
    // table D1 est mise à jour EN PLUS de ce stockage existant (jamais à sa
    // place), uniquement pour permettre ce tri rapide.
    async function ensureStreakTable(env) {
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS player_streaks (
          discordId TEXT PRIMARY KEY,
          pseudo TEXT,
          avatarUrl TEXT,
          streak INTEGER DEFAULT 0,
          lastTopUp TEXT
        )
      `).run();
    }

    async function upsertStreak(env, discordId, pseudo, avatarUrl, streak, lastTopUp){
      if (!env.VAULT_DB) return;
      try {
        await ensureStreakTable(env);
        await env.VAULT_DB.prepare(`
          INSERT INTO player_streaks (discordId, pseudo, avatarUrl, streak, lastTopUp)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(discordId) DO UPDATE SET
            streak = excluded.streak,
            lastTopUp = excluded.lastTopUp,
            pseudo = CASE WHEN excluded.pseudo != '' THEN excluded.pseudo ELSE pseudo END,
            avatarUrl = CASE WHEN excluded.avatarUrl != '' THEN excluded.avatarUrl ELSE avatarUrl END
        `).bind(discordId, pseudo || '', avatarUrl || '', streak || 0, lastTopUp || '').run();
      } catch (e) {
        console.warn('Mise à jour du classement de série échouée :', e.message);
      }
    }


    async function ensureWagerTotalsTable(env) {
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS wager_totals (
          discordId TEXT PRIMARY KEY,
          wager REAL DEFAULT 0,
          plays INTEGER DEFAULT 0,
          pseudo TEXT,
          avatarUrl TEXT,
          won REAL DEFAULT 0,
          bestMultiplier REAL DEFAULT 0,
          bestMultiplierGame TEXT DEFAULT '',
          bestMultiplierDate TEXT DEFAULT '',
          biggestBet REAL DEFAULT 0
        )
      `).run();
      // Ajout rétroactif des nouvelles colonnes si la table existait déjà
      // depuis la première migration (qui n'avait que wager/plays/pseudo/
      // avatarUrl). SQLite n'a pas de "ADD COLUMN IF NOT EXISTS" : on tente et
      // on avale l'erreur "duplicate column" si elle existe déjà.
      const newColumns = [
        ['won', 'REAL DEFAULT 0'],
        ['bestMultiplier', 'REAL DEFAULT 0'],
        ['bestMultiplierGame', "TEXT DEFAULT ''"],
        ['bestMultiplierDate', "TEXT DEFAULT ''"],
        ['biggestBet', 'REAL DEFAULT 0'],
      ];
      for (const [col, def] of newColumns) {
        try {
          await env.VAULT_DB.prepare(`ALTER TABLE wager_totals ADD COLUMN ${col} ${def}`).run();
        } catch (e) {
          // Colonne déjà présente : normal après le tout premier appel, on ignore.
        }
      }
    }

    async function getWagerTotals(env) {
      if (env.VAULT_DB) {
        try {
          await ensureWagerTotalsTable(env);
          const { results } = await env.VAULT_DB.prepare('SELECT * FROM wager_totals').all();
          if (results && results.length > 0) {
            const totals = {};
            for (const row of results) {
              totals[row.discordId] = {
                wager: roundKeys(row.wager || 0),
                plays: row.plays || 0,
                pseudo: row.pseudo || '',
                avatarUrl: row.avatarUrl || '',
                won: roundKeys(row.won || 0),
                bestMultiplier: row.bestMultiplier || 0,
                bestMultiplierGame: row.bestMultiplierGame || '',
                bestMultiplierDate: row.bestMultiplierDate || '',
                biggestBet: roundKeys(row.biggestBet || 0),
              };
            }
            return totals;
          }
        } catch (e) {
          console.warn('Lecture D1 des totaux misés échouée, repli sur KV :', e.message);
        }
      }
      const raw = await env.SUBMISSIONS.get('wager_totals');
      return raw ? JSON.parse(raw) : {};
    }

    // Lecture directe d'UN SEUL joueur (utilisée par /profile/summary : pas
    // besoin de charger tous les joueurs pour afficher la page d'une personne).
    async function getPlayerLifetimeStats(env, discordId) {
      if (!env.VAULT_DB || !discordId) return null;
      try {
        await ensureWagerTotalsTable(env);
        const row = await env.VAULT_DB.prepare('SELECT * FROM wager_totals WHERE discordId = ?').bind(discordId).first();
        if (!row) return null;
        return {
          wager: roundKeys(row.wager || 0),
          plays: row.plays || 0,
          won: roundKeys(row.won || 0),
          bestMultiplier: row.bestMultiplier || 0,
          bestMultiplierGame: row.bestMultiplierGame || '',
          bestMultiplierDate: row.bestMultiplierDate || '',
          biggestBet: roundKeys(row.biggestBet || 0),
        };
      } catch (e) {
        console.warn('Lecture D1 des stats joueur échouée :', e.message);
        return null;
      }
    }

    // Utilisée UNIQUEMENT par le backfill admin (rare, un seul appel manuel) :
    // remplace les stats d'un ou plusieurs joueurs par une valeur précise.
    // Contrairement à addLifetimeWager, ceci ÉCRASE plutôt que d'incrémenter —
    // c'est voulu ici puisque le backfill calcule la valeur définitive à poser.
    async function saveWagerTotals(env, totals) {
      if (env.VAULT_DB) {
        await ensureWagerTotalsTable(env);
        for (const [discordId, t] of Object.entries(totals)) {
          await env.VAULT_DB.prepare(`
            INSERT INTO wager_totals (discordId, wager, plays, pseudo, avatarUrl, won, bestMultiplier, bestMultiplierGame, bestMultiplierDate, biggestBet)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(discordId) DO UPDATE SET
              wager = excluded.wager, plays = excluded.plays,
              pseudo = excluded.pseudo, avatarUrl = excluded.avatarUrl,
              won = excluded.won, bestMultiplier = excluded.bestMultiplier,
              bestMultiplierGame = excluded.bestMultiplierGame, bestMultiplierDate = excluded.bestMultiplierDate,
              biggestBet = excluded.biggestBet
          `).bind(
            discordId, t.wager || 0, t.plays || 0, t.pseudo || '', t.avatarUrl || '',
            t.won || 0, t.bestMultiplier || 0, t.bestMultiplierGame || '', t.bestMultiplierDate || '', t.biggestBet || 0
          ).run();
        }
        return;
      }
      await env.SUBMISSIONS.put('wager_totals', JSON.stringify(totals));
    }

    // Appelée depuis chaque addXxxPlay avec le nom du jeu ('mines'/'blackjack'/
    // 'dice'/'slots'), pour que "meilleur multiplicateur" sache de quel jeu il
    // vient — exactement l'info affichée sur la page Profil ("4.39x Mines").
    async function addLifetimeWager(env, entry, gameName) {
      if (!entry || !entry.discordId) return;
      const bet = entry.bet || 0;
      // Mines a un champ "busted" : le payout/multiplier n'est valable QUE si
      // la partie n'a pas explosé. Les autres jeux n'ont pas ce champ, leur
      // payout est déjà correct tel quel (0 si perdu).
      const isMines = ('busted' in entry);
      const payout = isMines ? (entry.busted ? 0 : (entry.payout || 0)) : (entry.payout || 0);
      let mult = 0;
      if (isMines) {
        mult = entry.busted ? 0 : (entry.multiplier || 0);
      } else if (bet > 0) {
        mult = payout / bet;
      }
      const date = entry.date || '';

      if (env.VAULT_DB) {
        try {
          await ensureWagerTotalsTable(env);
          // UPSERT atomique : une seule instruction SQL, aucune fenêtre de
          // course possible même si deux parties se terminent à la même
          // milliseconde pour deux joueurs différents (ou le même).
          await env.VAULT_DB.prepare(`
            INSERT INTO wager_totals (discordId, wager, plays, pseudo, avatarUrl, won, bestMultiplier, bestMultiplierGame, bestMultiplierDate, biggestBet)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(discordId) DO UPDATE SET
              wager = wager + excluded.wager,
              plays = plays + 1,
              pseudo = CASE WHEN excluded.pseudo != '' THEN excluded.pseudo ELSE pseudo END,
              avatarUrl = CASE WHEN excluded.avatarUrl != '' THEN excluded.avatarUrl ELSE avatarUrl END,
              won = won + excluded.won,
              bestMultiplierGame = CASE WHEN excluded.bestMultiplier > bestMultiplier THEN excluded.bestMultiplierGame ELSE bestMultiplierGame END,
              bestMultiplierDate = CASE WHEN excluded.bestMultiplier > bestMultiplier THEN excluded.bestMultiplierDate ELSE bestMultiplierDate END,
              bestMultiplier = MAX(bestMultiplier, excluded.bestMultiplier),
              biggestBet = MAX(biggestBet, excluded.biggestBet)
          `).bind(
            entry.discordId, bet, entry.pseudo || '', entry.avatarUrl || '',
            payout, mult, gameName || '', date, bet
          ).run();
          return;
        } catch (e) {
          console.warn('UPSERT D1 des stats joueur échoué, repli sur KV :', e.message);
        }
      }
      // Repli si D1 indisponible (comportement historique, sujet à la race condition connue)
      try {
        const totals = await getWagerTotals(env);
        const t = totals[entry.discordId] || { wager: 0, plays: 0, pseudo: '', avatarUrl: '', won: 0, bestMultiplier: 0, bestMultiplierGame: '', bestMultiplierDate: '', biggestBet: 0 };
        t.wager = roundKeys(t.wager + bet);
        t.plays = (t.plays || 0) + 1;
        t.won = roundKeys((t.won || 0) + payout);
        if (mult > (t.bestMultiplier || 0)) {
          t.bestMultiplier = mult;
          t.bestMultiplierGame = gameName || '';
          t.bestMultiplierDate = date;
        }
        if (bet > (t.biggestBet || 0)) t.biggestBet = bet;
        if (entry.pseudo) t.pseudo = entry.pseudo;
        if (entry.avatarUrl) t.avatarUrl = entry.avatarUrl;
        totals[entry.discordId] = t;
        await env.SUBMISSIONS.put('wager_totals', JSON.stringify(totals));
      } catch (e) {
        console.warn('wager_totals non mis à jour (écriture concurrente) :', e.message);
      }
    }

    async function getMinesActiveRound(env, discordId) {
      const raw = await env.SUBMISSIONS.get(`mines_active_${discordId}`);
      return raw ? JSON.parse(raw) : null;
    }

    async function addMinesPlay(env, entry) {
      await addLifetimeWager(env, entry, 'mines');
      if (env.VAULT_DB) {
        try {
          await insertGamePlay(env, 'mines', entry);
          return;
        } catch (e) {
          console.warn('Insertion D1 de la partie mines échouée, repli KV :', e.message);
        }
      }
      // Repli si D1 indisponible (comportement historique, tronqué et sujet à la race condition connue)
      const raw = await env.SUBMISSIONS.get('mines_plays');
      const plays = raw ? JSON.parse(raw) : [];
      plays.push(entry);
      try {
        await env.SUBMISSIONS.put('mines_plays', JSON.stringify(plays.slice(-1000)));
      } catch (e) {
        console.warn('Historique mines_plays non enregistré (écritures concurrentes) :', e.message);
      }
    }

    // ---------------------------------------------------------------
    // GET /mines/status?discordId=... -> solde de clés + état d'une partie en cours (public)
    // ---------------------------------------------------------------
    // Définition unique des succès : utilisée à la fois pour l'affichage et pour
    // le paiement, afin que les deux ne puissent jamais diverger.
    const ACHIEVEMENT_DEFS = [
      { id: 'first_step',      icon: '🎯',  name: 'First Step',      desc: 'Play your first round',          reward: 2,   test: s => s.totalPlays >= 1 },
      { id: 'getting_started', icon: '🎲',  name: 'Getting Started', desc: 'Play 50 rounds',                 reward: 5,   test: s => s.totalPlays >= 50 },
      { id: 'regular',         icon: '🔥',  name: 'Regular',         desc: 'Play 500 rounds',                reward: 25,  test: s => s.totalPlays >= 500 },
      { id: 'veteran',         icon: '👑',  name: 'Veteran',         desc: 'Play 2,000 rounds',              reward: 100, test: s => s.totalPlays >= 2000 },
      { id: 'high_roller',     icon: '💰',  name: 'High Roller',     desc: 'Bet 100 keys in a single round', reward: 25,  test: s => s.biggestBet >= 100 },
      { id: 'big_win',         icon: '🚀',  name: 'Big Win',         desc: 'Hit a 10× multiplier',           reward: 15,  test: s => s.bestMultiplier >= 10 },
      { id: 'legendary',       icon: '🌟',  name: 'Legendary',       desc: 'Hit a 50× multiplier',           reward: 50,  test: s => s.bestMultiplier >= 50 },
      { id: 'blackjack',       icon: '🃏',  name: 'Blackjack!',      desc: 'Get a natural blackjack',        reward: 10,  test: s => s.hasBlackjack },
      { id: 'jackpot',         icon: '🎰',  name: 'Jackpot',         desc: 'Win on Slot with a 50+ key bet', reward: 30,  test: s => s.hasSlotJackpot50 },
      { id: 'explorer',        icon: '🗺️', name: 'Explorer',        desc: 'Play all 4 games',               reward: 5,   test: s => s.gamesPlayed.size >= 4 },
    ];

    async function getClaimedAchievements(env, discordId) {
      const raw = await env.SUBMISSIONS.get(`achievements_${discordId}`);
      return raw ? JSON.parse(raw) : {};
    }

    async function saveClaimedAchievements(env, discordId, claimed) {
      await env.SUBMISSIONS.put(`achievements_${discordId}`, JSON.stringify(claimed));
    }

    if (url.pathname === '/mines/status' && request.method === 'GET') {
      const discordId = (await authedDiscordId(request, env)) || '';
      const config = await getKeysConfig(env);
      if (!env.SUBMISSIONS || !discordId) {
        return new Response(JSON.stringify({ keys: 0, dailyKeys: config.dailyKeys, active: null }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const balance = await getKeysBalance(env, discordId, config);
      const active = await getMinesActiveRound(env, discordId);
      let activeState = null;
      if (active) {
        activeState = {
          bet: active.bet,
          step: active.step,
          revealed: active.revealed,
          mineCount: active.mineCount || MINES_BOMB_COUNT_DEFAULT,
          multiplier: minesMultiplierForStep(active.step, active.mineCount),
        };
      }
      // Récompenses en attente : sert à afficher la pastille sur la cloche de
      // toutes les pages, sans appel serveur supplémentaire.
      const today = new Date().toISOString().slice(0, 10);
      const dailyAvailable = balance.lastTopUp !== today;

      // Les succès ne sont volontairement pas testés ici : il faudrait parcourir
      // tout l'historique des 4 jeux à chaque chargement de page, ce qui coûterait
      // cher pour un simple point rouge. La page Profil, elle, les calcule.
      const achievementsPending = false;

      return new Response(JSON.stringify({
        keys: balance.keys, dailyKeys: config.dailyKeys, active: activeState,
        rewards: { daily: dailyAvailable, achievements: achievementsPending },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /mines/start -> mise une partie (débite le solde, génère les bombes côté serveur)
    // ---------------------------------------------------------------
    if (url.pathname === '/mines/start' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const pseudo = String(body.pseudo || '').trim().slice(0, 60);
      const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 300);
      const bet = roundKeys(parseFloat(body.bet));
      let mineCount = parseInt(body.mineCount, 10);
      if (!MINES_ALLOWED_BOMB_COUNTS.includes(mineCount)) mineCount = MINES_BOMB_COUNT_DEFAULT;
      if (!discordId || !pseudo || !Number.isFinite(bet) || bet < MIN_BET_KEYS) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_fields' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const userEntryMines = await touchUserDirectory(env, discordId, pseudo, avatarUrl);
      if (userEntryMines.banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Même logique que le Blackjack : une manche restée en mémoire à cause d'un
      // incident réseau ne doit pas bloquer le joueur indéfiniment.
      const existingActive = await getMinesActiveRound(env, discordId);
      if (existingActive) {
        const isStale = existingActive.startedAt && (Date.now() - existingActive.startedAt) > 60 * 60 * 1000;
        if (!isStale) {
          return new Response(JSON.stringify({ ok: false, reason: 'round_in_progress' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        await env.SUBMISSIONS.delete(`mines_active_${discordId}`);
      }

      const config = await getKeysConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      if (bet > balance.keys) {
        return new Response(JSON.stringify({ ok: false, reason: 'insufficient_keys', keys: balance.keys }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Débit immédiat (mis en jeu) : recrédité au cash-out, perdu si bombe touchée
      balance.keys = roundKeys(balance.keys - bet);
      await saveKeysBalance(env, discordId, balance);

      const bombs = new Set();
      while (bombs.size < mineCount) {
        bombs.add(Math.floor(Math.random() * MINES_TILE_COUNT));
      }

      const active = { discordId, pseudo, avatarUrl, bet, mineCount, bombs: [...bombs], step: 0, revealed: [], startedAt: Date.now() };
      await env.SUBMISSIONS.put(`mines_active_${discordId}`, JSON.stringify(active));

      return new Response(JSON.stringify({ ok: true, keys: balance.keys }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /mines/reveal -> révèle une case (public, la partie doit être en cours)
    // ---------------------------------------------------------------
    if (url.pathname === '/mines/reveal' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const tileIndex = parseInt(body.tileIndex, 10);
      if (!discordId || !Number.isFinite(tileIndex) || tileIndex < 0 || tileIndex >= MINES_TILE_COUNT) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_fields' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const active = await getMinesActiveRound(env, discordId);
      if (!active) {
        return new Response(JSON.stringify({ ok: false, reason: 'no_active_round' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (active.revealed.includes(tileIndex)) {
        return new Response(JSON.stringify({ ok: false, reason: 'tile_already_revealed' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const isBomb = active.bombs.includes(tileIndex);

      if (isBomb) {
        // Partie perdue : la mise était déjà débitée au /start, rien à recréditer
        await env.SUBMISSIONS.delete(`mines_active_${discordId}`);
        await addMinesPlay(env, {
          id: crypto.randomUUID(),
          date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          dateMs: Date.now(),
          pseudo: active.pseudo,
          avatarUrl: active.avatarUrl || '',
          discordId,
          bet: active.bet,
          busted: true,
          multiplier: 0,
          payout: 0,
          tipped: false,
          // Détail affiché dans la popup d'historique
          details: {
            mineCount: active.mineCount,
            bombs: active.bombs,
            revealed: active.revealed,
            step: active.step,
          },
        });
        return new Response(JSON.stringify({ ok: true, hit: true, bombs: active.bombs }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      active.revealed.push(tileIndex);
      active.step += 1;
      await env.SUBMISSIONS.put(`mines_active_${discordId}`, JSON.stringify(active));

      const multiplier = minesMultiplierForStep(active.step - 1, active.mineCount);
      const profit = roundKeys(active.bet * (multiplier - 1));

      return new Response(JSON.stringify({ ok: true, hit: false, step: active.step, multiplier, profit }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /mines/cashout -> encaisse la partie en cours au multiplicateur atteint
    // ---------------------------------------------------------------
    if (url.pathname === '/mines/cashout' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (!discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_fields' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const active = await getMinesActiveRound(env, discordId);
      if (!active) {
        return new Response(JSON.stringify({ ok: false, reason: 'no_active_round' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (active.step < 1) {
        return new Response(JSON.stringify({ ok: false, reason: 'nothing_revealed' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const config = await getKeysConfig(env);
      const multiplier = minesMultiplierForStep(active.step - 1, active.mineCount);
      const payout = roundKeys(active.bet * multiplier);

      const balance = await getKeysBalance(env, discordId, config);
      balance.keys = roundKeys(balance.keys + payout);
      await saveKeysBalance(env, discordId, balance);
      await env.SUBMISSIONS.delete(`mines_active_${discordId}`);

      await addMinesPlay(env, {
        id: crypto.randomUUID(),
        date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        dateMs: Date.now(),
        pseudo: active.pseudo,
        avatarUrl: active.avatarUrl || '',
        discordId,
        bet: active.bet,
        busted: false,
        multiplier,
        payout,
        tipped: false,
        details: {
          mineCount: active.mineCount,
          bombs: active.bombs,
          revealed: active.revealed,
          step: active.step,
        },
      });

      return new Response(JSON.stringify({ ok: true, payout, keys: balance.keys, bombs: active.bombs, bet: active.bet, multiplier }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /mines/history?limit=20 -> historique PUBLIC (tous les joueurs)
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // GET /bet?id=... -> retrouve une partie par son identifiant, tous jeux
    // confondus. Sert aux liens partageables (?bet=ID) : un joueur peut ainsi
    // montrer une manche précise, et toi la retrouver s'il te la signale.
    // ---------------------------------------------------------------
    // =================================================================
    // PARRAINAGE — un joueur partage son lien (drop-cash.com/?ref=<discordId>),
    // et touche 100 clés (créditées directement dans son solde de jeu normal)
    // quand quelqu'un se connecte pour la toute première fois via Discord
    // grâce à ce lien. Plus d'argent réel séparé ici — pour ça, voir le
    // système de conversion clés -> $ juste en dessous.
    // =================================================================
    const REFERRAL_KEYS_REWARD = 100;
    // =================================================================
    // CONVERSION CLÉS -> ARGENT RÉEL — taux fixe 100 clés = 1$. Système
    // séparé du parrainage (sa propre table, son propre historique) pour
    // garder une traçabilité claire de la source de chaque dollar. Retrait
    // manuel uniquement, jamais automatique, à partir de 100$ — même
    // principe que le parrainage.
    // =================================================================
    const KEYS_PER_DOLLAR = 100;

    async function ensureCashTables(env) {
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS cash_balances (
          discordId TEXT PRIMARY KEY,
          pseudo TEXT,
          balance REAL DEFAULT 0
        )
      `).run();
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS cash_conversions (
          id TEXT PRIMARY KEY,
          discordId TEXT,
          pseudo TEXT,
          keysConverted REAL,
          dollarsCredited REAL,
          dateMs INTEGER
        )
      `).run();
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS cash_withdrawals (
          id TEXT PRIMARY KEY,
          discordId TEXT,
          pseudo TEXT,
          amount REAL,
          dateMs INTEGER,
          status TEXT,
          processedAtMs INTEGER,
          note TEXT
        )
      `).run();
    }

    // POST /keys/convert -> convertit TOUT le solde actuel de clés du joueur
    // en dollars, au taux fixe. Remet les clés à 0 (le joueur choisit lui-même
    // ce compromis : plus de clés pour jouer, mais un solde en argent réel).
    if (url.pathname === '/keys/convert' && request.method === 'POST') {
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.VAULT_DB || !discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_authenticated' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Verrou atomique : deux requêtes qui arrivent en même temps (double-clic,
      // requête réseau qui traîne puis un second essai...) ne doivent JAMAIS
      // pouvoir lire le même solde et créditer deux fois. Une contrainte
      // PRIMARY KEY sur un INSERT est la seule opération vraiment atomique
      // disponible ici (contrairement à un simple "lire puis écrire", qui
      // laisse une fenêtre où deux requêtes peuvent lire la même valeur avant
      // qu'aucune n'ait écrit sa mise à jour).
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS conversion_locks (discordId TEXT PRIMARY KEY, lockedAtMs INTEGER)
      `).run();
      const nowMs = Date.now();
      try {
        await env.VAULT_DB.prepare(
          'INSERT INTO conversion_locks (discordId, lockedAtMs) VALUES (?, ?)'
        ).bind(discordId, nowMs).run();
      } catch (e) {
        // Un verrou existe déjà : soit une conversion est en cours à l'instant
        // (rejet propre), soit un verrou est resté coincé après un plantage —
        // dans ce cas (plus de 30s), on le remplace pour ne jamais bloquer
        // quelqu'un pour de bon.
        const existing = await env.VAULT_DB.prepare(
          'SELECT lockedAtMs FROM conversion_locks WHERE discordId = ?'
        ).bind(discordId).first();
        if (existing && (nowMs - existing.lockedAtMs) < 30000) {
          return new Response(JSON.stringify({ ok: false, reason: 'already_processing' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        await env.VAULT_DB.prepare(
          'UPDATE conversion_locks SET lockedAtMs = ? WHERE discordId = ?'
        ).bind(nowMs, discordId).run();
      }

      try {
        const config = await getKeysConfig(env);
        const balance = await getKeysBalance(env, discordId, config);
        const keys = roundKeys(balance.keys || 0);
        if (keys <= 0) {
          return new Response(JSON.stringify({ ok: false, reason: 'no_keys' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const dollars = roundKeys(keys / KEYS_PER_DOLLAR);

        balance.keys = 0;
        await saveKeysBalance(env, discordId, balance);

        await ensureCashTables(env);
        const dir = await getUserDirectory(env);
        const pseudo = (dir[discordId] && dir[discordId].pseudo) || '';
        await env.VAULT_DB.prepare(`
          INSERT INTO cash_balances (discordId, pseudo, balance)
          VALUES (?, ?, ?)
          ON CONFLICT(discordId) DO UPDATE SET
            balance = balance + excluded.balance,
            pseudo = CASE WHEN excluded.pseudo != '' THEN excluded.pseudo ELSE pseudo END
        `).bind(discordId, pseudo, dollars).run();
        await env.VAULT_DB.prepare(`
          INSERT INTO cash_conversions (id, discordId, pseudo, keysConverted, dollarsCredited, dateMs)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), discordId, pseudo, keys, dollars, Date.now()).run();

        return new Response(JSON.stringify({ ok: true, keysConverted: keys, dollarsCredited: dollars }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } finally {
        // Le verrou est TOUJOURS libéré à la fin, succès ou échec — sinon un
        // joueur resterait bloqué jusqu'à l'expiration de 30s pour rien.
        await env.VAULT_DB.prepare('DELETE FROM conversion_locks WHERE discordId = ?').bind(discordId).run();
      }
    }

    // GET /cash/status?discordId=... -> solde $ + état d'une éventuelle
    // demande de retrait en cours.
    if (url.pathname === '/cash/status' && request.method === 'GET') {
      const discordId = url.searchParams.get('discordId') || '';
      if (!env.VAULT_DB || !discordId) {
        return new Response(JSON.stringify({ ok: true, balance: 0, pendingWithdrawal: false }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureCashTables(env);
      const row = await env.VAULT_DB.prepare(
        'SELECT balance FROM cash_balances WHERE discordId = ?'
      ).bind(discordId).first();
      const pending = await env.VAULT_DB.prepare(
        "SELECT id FROM cash_withdrawals WHERE discordId = ? AND status = 'pending' LIMIT 1"
      ).bind(discordId).first();
      return new Response(JSON.stringify({
        ok: true,
        balance: row ? roundKeys(row.balance || 0) : 0,
        pendingWithdrawal: !!pending,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // POST /cash/withdraw -> crée une DEMANDE de retrait (jamais de paiement
    // automatique). Nécessite au moins 100$, et aucune demande déjà en attente.
    if (url.pathname === '/cash/withdraw' && request.method === 'POST') {
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.VAULT_DB || !discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_authenticated' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureCashTables(env);
      const row = await env.VAULT_DB.prepare(
        'SELECT balance, pseudo FROM cash_balances WHERE discordId = ?'
      ).bind(discordId).first();
      const balance = row ? roundKeys(row.balance || 0) : 0;
      if (balance < 100) {
        return new Response(JSON.stringify({ ok: false, reason: 'balance_too_low', balance }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const existingPending = await env.VAULT_DB.prepare(
        "SELECT id FROM cash_withdrawals WHERE discordId = ? AND status = 'pending' LIMIT 1"
      ).bind(discordId).first();
      if (existingPending) {
        return new Response(JSON.stringify({ ok: false, reason: 'already_pending' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await env.VAULT_DB.prepare(`
        INSERT INTO cash_withdrawals (id, discordId, pseudo, amount, dateMs, status, processedAtMs, note)
        VALUES (?, ?, ?, ?, ?, 'pending', NULL, '')
      `).bind(crypto.randomUUID(), discordId, (row && row.pseudo) || '', balance, Date.now()).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- Onglet "Retrait $" du dashboard (protégé) ----
    if (url.pathname === '/admin/cash/withdrawals' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ withdrawals: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureCashTables(env);
      const { results } = await env.VAULT_DB.prepare(
        'SELECT * FROM cash_withdrawals ORDER BY dateMs DESC'
      ).all();
      return new Response(JSON.stringify({ withdrawals: results || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/admin/cash/conversions' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ conversions: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureCashTables(env);
      const { results } = await env.VAULT_DB.prepare(
        'SELECT * FROM cash_conversions ORDER BY dateMs DESC LIMIT 100'
      ).all();
      return new Response(JSON.stringify({ conversions: results || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /admin/cash/withdrawals/update -> marque une demande de retrait
    // payée ou refusée. Ne touche JAMAIS au solde automatiquement autrement :
    // le versement réel se fait à la main, en dehors du site, par toi.
    if (url.pathname === '/admin/cash/withdrawals/update' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response('Base D1 non configurée', { status: 500, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const { id, status, note } = body;
      if (!id || !['paid', 'declined'].includes(status)) {
        return new Response('Paramètres invalides', { status: 400, headers: corsHeaders });
      }
      await ensureCashTables(env);
      const reqRow = await env.VAULT_DB.prepare('SELECT * FROM cash_withdrawals WHERE id = ?').bind(id).first();
      if (!reqRow) {
        return new Response('Introuvable', { status: 404, headers: corsHeaders });
      }
      await env.VAULT_DB.prepare(
        'UPDATE cash_withdrawals SET status = ?, processedAtMs = ?, note = ? WHERE id = ?'
      ).bind(status, Date.now(), note || '', id).run();
      if (status === 'paid') {
        await env.VAULT_DB.prepare(
          'UPDATE cash_balances SET balance = MAX(0, balance - ?) WHERE discordId = ?'
        ).bind(reqRow.amount, reqRow.discordId).run();
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }


    async function ensureReferralTables(env) {
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS referrals (
          referredId TEXT PRIMARY KEY,
          referrerId TEXT,
          referrerPseudo TEXT,
          referredPseudo TEXT,
          referredAvatarUrl TEXT,
          dateMs INTEGER,
          deviceId TEXT,
          ip TEXT
        )
      `).run();
      await env.VAULT_DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrerId)
      `).run();
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS referral_balances (
          discordId TEXT PRIMARY KEY,
          pseudo TEXT,
          balance REAL DEFAULT 0,
          referralCount INTEGER DEFAULT 0
        )
      `).run();
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS referral_withdrawals (
          id TEXT PRIMARY KEY,
          discordId TEXT,
          pseudo TEXT,
          amount REAL,
          dateMs INTEGER,
          status TEXT,
          processedAtMs INTEGER,
          note TEXT
        )
      `).run();
    }

    // POST /referral/register -> crédite le parrain quand un NOUVEAU membre se
    // connecte via son lien. "Nouveau" = ce discordId n'apparaît nulle part
    // encore dans l'annuaire des joueurs (jamais joué, jamais réclamé de bonus,
    // jamais connecté avant) — appelé une seule fois, juste après la toute
    // première connexion Discord réussie (voir discord-callback.html).
    // POST /referral/register -> crédite le parrain de 100 CLÉS (directement
    // dans son solde de jeu habituel — plus d'argent réel séparé pour le
    // parrainage) quand un NOUVEAU membre se connecte via son lien. Le worker
    // vérifie lui-même que ce membre est bien nouveau.
    if (url.pathname === '/referral/register' && request.method === 'POST') {
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ ok: false, reason: 'd1_unavailable' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'invalid_json' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { referrerId, referredId, referredPseudo, referredAvatarUrl, deviceId } = body;
      const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
      if (!referrerId || !referredId || referrerId === referredId) {
        return new Response(JSON.stringify({ ok: false, reason: 'invalid_params' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureReferralTables(env);

      // Le filleul doit être authentiquement nouveau : jamais vu dans
      // l'annuaire (aucune partie jouée, aucun bonus réclamé, aucune
      // connexion antérieure) avant ce tout premier lien Discord.
      const dir = await getUserDirectory(env);
      if (dir[referredId]) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_new_member' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Le parrain doit lui-même être un membre déjà connu (pas un lien inventé)
      if (!dir[referrerId]) {
        return new Response(JSON.stringify({ ok: false, reason: 'unknown_referrer' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      try {
        const insertResult = await env.VAULT_DB.prepare(`
          INSERT OR IGNORE INTO referrals (referredId, referrerId, referrerPseudo, referredPseudo, referredAvatarUrl, dateMs, deviceId, ip)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          referredId, referrerId, dir[referrerId].pseudo || '', referredPseudo || '', referredAvatarUrl || '',
          Date.now(), deviceId || '', ip || ''
        ).run();

        // INSERT OR IGNORE ne signale pas explicitement s'il a ignoré ou inséré :
        // on vérifie via meta.changes (0 = déjà existant, donc déjà crédité avant).
        if (!insertResult.meta || insertResult.meta.changes === 0) {
          return new Response(JSON.stringify({ ok: false, reason: 'already_referred' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Crédit de 100 clés, directement dans le solde de jeu habituel du parrain.
        const config = await getKeysConfig(env);
        const balance = await getKeysBalance(env, referrerId, config);
        balance.keys = roundKeys((balance.keys || 0) + REFERRAL_KEYS_REWARD);
        await saveKeysBalance(env, referrerId, balance);

        // Compteur de parrainages, pour affichage seulement (plus de solde $).
        await env.VAULT_DB.prepare(`
          INSERT INTO referral_balances (discordId, pseudo, balance, referralCount)
          VALUES (?, ?, 0, 1)
          ON CONFLICT(discordId) DO UPDATE SET
            referralCount = referralCount + 1,
            pseudo = CASE WHEN excluded.pseudo != '' THEN excluded.pseudo ELSE pseudo END
        `).bind(referrerId, dir[referrerId].pseudo || '').run();

        return new Response(JSON.stringify({ ok: true, keysCredited: REFERRAL_KEYS_REWARD }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'error', error: e.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /referral/status?discordId=... -> nombre de parrainages (pour le
    // Profil). Plus de solde $ ni de retrait séparé : les clés gagnées sont
    // déjà dans le solde de jeu normal du joueur.
    if (url.pathname === '/referral/status' && request.method === 'GET') {
      const discordId = url.searchParams.get('discordId') || '';
      if (!env.VAULT_DB || !discordId) {
        return new Response(JSON.stringify({ ok: true, referralCount: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureReferralTables(env);
      const row = await env.VAULT_DB.prepare(
        'SELECT referralCount FROM referral_balances WHERE discordId = ?'
      ).bind(discordId).first();
      return new Response(JSON.stringify({
        ok: true,
        referralCount: row ? (row.referralCount || 0) : 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---- Onglet "Parrainage" du dashboard (protégé) ----
    if (url.pathname === '/referral/admin/list' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ referrals: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureReferralTables(env);
      const { results } = await env.VAULT_DB.prepare(
        'SELECT * FROM referrals ORDER BY dateMs DESC'
      ).all();
      return new Response(JSON.stringify({ referrals: results || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }


    async function ensureSharedBetsTable(env) {
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS shared_bets (
          id TEXT PRIMARY KEY,
          game TEXT,
          data TEXT,
          sharedAtMs INTEGER
        )
      `).run();
    }

    // POST /bet/share -> copie un pari (encore présent dans le log tronqué au
    // moment du partage) vers ce stockage permanent. Appelé au clic sur
    // "Copy share link", pas à chaque pari — écriture rare, aucun risque de
    // course avec les logs de parties.
    if (url.pathname === '/bet/share' && request.method === 'POST') {
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ ok: false, reason: 'd1_unavailable' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'invalid_json' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { id, game } = body;
      // Le paramètre envoyé par les pages de jeu utilise "slot" (singulier),
      // mais la table D1/les clés internes utilisent "slots" (comme pour les
      // 3 autres jeux) — on normalise ici pour ne jamais rater la partie.
      const validGames = { mines: 'mines', blackjack: 'blackjack', dice: 'dice', slot: 'slots' };
      const normalizedGame = validGames[game];
      if (!id || !normalizedGame || !env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'invalid_params' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const plays = await getGamePlays(env, normalizedGame);
      const p = plays.find(x => x.id === id);
      if (!p) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureSharedBetsTable(env);
      await env.VAULT_DB.prepare(`
        INSERT OR IGNORE INTO shared_bets (id, game, data, sharedAtMs) VALUES (?, ?, ?, ?)
      `).bind(id, game, JSON.stringify(p), Date.now()).run();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/bet' && request.method === 'GET') {
      const betId = (url.searchParams.get('id') || '').trim();
      if (!betId) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // 1) D'abord le stockage permanent (paris explicitement partagés) : ne
      // dépend d'aucune troncature, disponible indéfiniment.
      if (env.VAULT_DB) {
        try {
          await ensureSharedBetsTable(env);
          const row = await env.VAULT_DB.prepare('SELECT * FROM shared_bets WHERE id = ?').bind(betId).first();
          if (row) {
            const p = JSON.parse(row.data);
            return new Response(JSON.stringify({
              ok: true,
              bet: {
                game: row.game,
                id: p.id, pseudo: p.pseudo, avatarUrl: p.avatarUrl || '',
                bet: p.bet, payout: p.payout, date: p.date, dateMs: p.dateMs,
                busted: p.busted, multiplier: p.multiplier, result: p.result, won: p.won,
                details: p.details || { roll: p.roll, target: p.target, direction: p.direction, symbols: p.symbols },
              },
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        } catch (e) {
          console.warn('Lecture shared_bets échouée :', e.message);
        }
      }
      // 2) Repli : pari pas (encore) explicitement partagé, on cherche dans
      // l'historique complet du jeu concerné (D1 si disponible, sinon les
      // logs KV tronqués aux 1000 dernières parties).
      const sources = { mines: 'mines', blackjack: 'blackjack', dice: 'dice', slot: 'slots' };
      for (const [game, internalGame] of Object.entries(sources)) {
        const plays = await getGamePlays(env, internalGame);
        const p = plays.find(x => x.id === betId);
        if (!p) continue;
        return new Response(JSON.stringify({
          ok: true,
          bet: {
            game,
            id: p.id,
            pseudo: p.pseudo,
            avatarUrl: p.avatarUrl || '',
            bet: p.bet,
            payout: p.payout,
            date: p.date,
            dateMs: p.dateMs,
            // Champs propres à chaque jeu, repris tels quels
            busted: p.busted,
            multiplier: p.multiplier,
            result: p.result,
            won: p.won,
            details: p.details || {
              roll: p.roll, target: p.target, direction: p.direction, symbols: p.symbols,
            },
          },
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: false, reason: 'not_found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/mines/history' && request.method === 'GET') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ history: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 20, 50);
      const plays = await getGamePlays(env, 'mines');
      const history = plays.slice(-limit).reverse().map(p => ({
        id: p.id, pseudo: p.pseudo, avatarUrl: p.avatarUrl || '', bet: p.bet, busted: p.busted, multiplier: p.multiplier, payout: p.payout, date: p.date, dateMs: p.dateMs, details: p.details || null,
      }));
      return new Response(JSON.stringify({ history }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /mines/my-history?discordId=...&limit=20 -> historique PERSONNEL
    // ---------------------------------------------------------------
    if (url.pathname === '/mines/my-history' && request.method === 'GET') {
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.SUBMISSIONS || !discordId) {
        return new Response(JSON.stringify({ history: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 20, 50);
      const plays = await getGamePlays(env, 'mines');
      const history = plays.filter(p => p.discordId === discordId).slice(-limit).reverse().map(p => ({
        id: p.id, pseudo: p.pseudo, avatarUrl: p.avatarUrl || '', bet: p.bet, busted: p.busted, multiplier: p.multiplier, payout: p.payout, date: p.date, dateMs: p.dateMs, details: p.details || null,
      }));
      return new Response(JSON.stringify({ history }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /mines/admin-state -> réglages actuels de Mines (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/mines/admin-state' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const config = await getKeysConfig(env);
      return new Response(JSON.stringify(config), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /mines/set -> définit le nombre de clés offertes par jour (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/mines/set' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const dailyKeys = parseInt(body.dailyKeys, 10);
      if (isNaN(dailyKeys) || dailyKeys < 0) {
        return new Response('Valeur invalide', { status: 400, headers: corsHeaders });
      }
      await env.SUBMISSIONS.put('mines_config', JSON.stringify({ dailyKeys }));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /admin/users?search=... -> liste tous les joueurs connus (annuaire + solde de clés),
    // filtrable par pseudo/Discord ID (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/users' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const search = (url.searchParams.get('search') || '').toLowerCase().trim();
      const config = await getKeysConfig(env);
      const dir = await getUserDirectory(env);
      // Comptes masqués des classements et des statistiques (comptes de test...)
      const userAdjustments = await getWagerAdjustments(env);
      const userExcluded = userAdjustments.__excluded || {};
      const entries = await Promise.all(Object.keys(dir).map(async (discordId) => {
        const entry = dir[discordId];
        const balanceRaw = await env.SUBMISSIONS.get(`mines_balance_${discordId}`);
        const balance = balanceRaw ? JSON.parse(balanceRaw) : { keys: 0, lastTopUp: null };
        return {
          discordId,
          pseudo: entry.pseudo || '',
          avatarUrl: entry.avatarUrl || '',
          keys: balance.keys || 0,
          banned: !!entry.banned,
          excluded: !!userExcluded[discordId],
          lastSeen: entry.lastSeen || null,
        };
      }));
      const filtered = search
        ? entries.filter(e => e.pseudo.toLowerCase().includes(search) || e.discordId.includes(search))
        : entries;
      filtered.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return new Response(JSON.stringify({ users: filtered, dailyKeys: config.dailyKeys, total: entries.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /admin/users/keys -> ajoute, retire ou fixe le solde de clés d'un joueur (protégé)
    // body: { discordId, mode: 'add'|'remove'|'set', amount }
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/users/keys' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const discordId = String(body.discordId || '').trim();
      const mode = String(body.mode || 'add');
      const amount = parseFloat(body.amount);
      if (!discordId || !Number.isFinite(amount)) {
        return new Response('Champs invalides', { status: 400, headers: corsHeaders });
      }
      const config = await getKeysConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      if (mode === 'add') balance.keys = roundKeys(balance.keys + amount);
      else if (mode === 'remove') balance.keys = roundKeys(Math.max(0, balance.keys - amount));
      else balance.keys = roundKeys(Math.max(0, amount)); // 'set'
      await saveKeysBalance(env, discordId, balance);
      return new Response(JSON.stringify({ ok: true, keys: balance.keys }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /admin/users/ban -> bannit/débannit un joueur (bloque les mises Mines/Blackjack, protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/users/ban' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const discordId = String(body.discordId || '').trim();
      const banned = !!body.banned;
      if (!discordId) {
        return new Response('discordId manquant', { status: 400, headers: corsHeaders });
      }
      const dir = await getUserDirectory(env);
      if (!dir[discordId]) {
        return new Response('Joueur introuvable', { status: 404, headers: corsHeaders });
      }
      dir[discordId].banned = banned;
      await env.SUBMISSIONS.put('user_directory', JSON.stringify(dir));
      return new Response(JSON.stringify({ ok: true, banned }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // =================================================================
    // BLACKJACK — même monnaie "clés" que Mines (solde partagé). Le croupier
    // reste sur 17 (soft compris). Blackjack naturel payé 3:2. Un seul split
    // autorisé (pas de re-split), double disponible sur les 2 premières cartes
    // de chaque main. Les cartes sont mélangées côté serveur, jamais exposées
    // au client avant d'être révélées.
    // =================================================================
    const BJ_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const BJ_SUITS = ['♠','♥','♦','♣'];

    function bjFreshShuffledDeck() {
      const deck = [];
      for (const s of BJ_SUITS) for (const r of BJ_RANKS) deck.push({ rank: r, suit: s });
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      return deck;
    }

    function bjHandValue(cards) {
      let total = 0, aces = 0;
      for (const c of cards) {
        if (c.rank === 'A') { aces++; total += 11; }
        else if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J') total += 10;
        else total += parseInt(c.rank, 10);
      }
      while (total > 21 && aces > 0) { total -= 10; aces--; }
      return { total, soft: aces > 0, bust: total > 21, blackjack: total === 21 && cards.length === 2 };
    }

    async function getBlackjackConfig(env) {
      return await getKeysConfig(env); // même config de clés que Mines
    }

    async function getBlackjackActiveRound(env, discordId) {
      const raw = await env.SUBMISSIONS.get(`blackjack_active_${discordId}`);
      return raw ? JSON.parse(raw) : null;
    }

    async function saveBlackjackActiveRound(env, discordId, active) {
      await env.SUBMISSIONS.put(`blackjack_active_${discordId}`, JSON.stringify(active));
    }

    async function clearBlackjackActiveRound(env, discordId) {
      await env.SUBMISSIONS.delete(`blackjack_active_${discordId}`);
    }

    async function addBlackjackPlay(env, entry) {
      await addLifetimeWager(env, entry, 'blackjack');
      if (env.VAULT_DB) {
        try {
          await insertGamePlay(env, 'blackjack', entry);
          return;
        } catch (e) {
          console.warn('Insertion D1 de la partie blackjack échouée, repli KV :', e.message);
        }
      }
      // Repli si D1 indisponible (comportement historique, tronqué et sujet à la race condition connue)
      const raw = await env.SUBMISSIONS.get('blackjack_plays');
      const plays = raw ? JSON.parse(raw) : [];
      plays.push(entry);
      try {
        await env.SUBMISSIONS.put('blackjack_plays', JSON.stringify(plays.slice(-1000)));
      } catch (e) {
        console.warn('Historique blackjack_plays non enregistré (écritures concurrentes) :', e.message);
      }
    }

    // Fait jouer le croupier (reste sur 17, quel que soit soft/hard) puis règle
    // chaque main du joueur. Modifie `active` en place (résultats + payout total).
    function bjResolveDealerAndHands(active) {
      const deck = active.deck;
      let dealerCards = active.dealerCards;
      // Le croupier ne joue que s'il reste au moins une main pas déjà "bust"
      const anyLive = active.hands.some(h => h.status !== 'bust');
      if (anyLive) {
        while (bjHandValue(dealerCards).total < 17) {
          dealerCards = [...dealerCards, deck.pop()];
        }
      }
      active.dealerCards = dealerCards;
      const dealerVal = bjHandValue(dealerCards);

      let totalPayout = 0;
      for (const hand of active.hands) {
        const playerVal = bjHandValue(hand.cards);
        let payout = 0;
        let result;
        if (hand.status === 'bust') {
          result = 'lose'; payout = 0;
        } else if (playerVal.blackjack && !hand.fromSplit) {
          if (dealerVal.blackjack) { result = 'push'; payout = hand.bet; }
          else { result = 'blackjack'; payout = roundKeys(hand.bet * 2.5); } // mise rendue + 3:2
        } else if (dealerVal.bust) {
          result = 'win'; payout = roundKeys(hand.bet * 2);
        } else if (playerVal.total > dealerVal.total) {
          result = 'win'; payout = roundKeys(hand.bet * 2);
        } else if (playerVal.total === dealerVal.total) {
          result = 'push'; payout = hand.bet;
        } else {
          result = 'lose'; payout = 0;
        }
        hand.result = result;
        hand.payout = roundKeys(payout);
        totalPayout += hand.payout;
      }
      active.status = 'resolved';
      active.totalPayout = roundKeys(totalPayout);
      return active;
    }

    // Détail d'une manche terminée, pour la popup d'historique côté joueur.
    // On ne garde que ce qui est utile à l'affichage (cartes et totaux).
    function bjRoundDetails(active) {
      return {
        dealerCards: active.dealerCards,
        dealerTotal: bjHandValue(active.dealerCards).total,
        hands: active.hands.map(h => ({
          cards: h.cards,
          total: bjHandValue(h.cards).total,
          bet: h.bet,
          result: h.result,
          payout: h.payout,
        })),
        insuranceTaken: !!active.insuranceTaken,
      };
    }

    function bjPublicHandState(active) {
      const isResolved = active.status === 'resolved';
      const activeHand = active.hands[active.activeHandIndex];
      const activeVal = activeHand ? bjHandValue(activeHand.cards) : null;
      const dealerUpIsAce = active.dealerCards[0] && active.dealerCards[0].rank === 'A';
      return {
        hands: active.hands.map(h => ({
          cards: h.cards, bet: h.bet, status: h.status,
          result: isResolved ? h.result : undefined,
          payout: isResolved ? h.payout : undefined,
        })),
        activeHandIndex: active.activeHandIndex,
        dealerCards: isResolved ? active.dealerCards : [active.dealerCards[0]],
        dealerHidden: !isResolved,
        status: active.status,
        totalPayout: isResolved ? active.totalPayout : undefined,
        canSplit: active.hands.length === 1 && !active.hands[0].fromSplit &&
          active.hands[0].cards.length === 2 &&
          active.hands[0].cards[0].rank === active.hands[0].cards[1].rank &&
          active.status === 'playing',
        // Pas de Hit ni de Double à 21 : tirer n'aurait aucun intérêt
        canHit: active.status === 'playing' && !!activeVal && activeVal.total < 21,
        canDouble: active.status === 'playing' && activeHand &&
          activeHand.cards.length === 2 && activeVal && activeVal.total < 21,
        // Assurance : proposée uniquement au tout début, si la carte visible du
        // croupier est un As et que le joueur n'a pas encore agi.
        canInsure: active.status === 'playing' && dealerUpIsAce &&
          !active.insuranceResolved && active.hands.length === 1 &&
          active.hands[0].cards.length === 2 && !active.hands[0].fromSplit &&
          active.hands[0].status === 'active',
        insuranceCost: active.hands[0] ? roundKeys(active.hands[0].bet / 2) : 0,
        insuranceTaken: !!active.insuranceTaken,
      };
    }

    // Avance vers la main suivante non terminée, ou passe en résolution si toutes le sont
    function bjAdvanceOrResolve(active) {
      let idx = active.activeHandIndex;
      while (idx < active.hands.length && active.hands[idx].status !== 'active') idx++;
      if (idx < active.hands.length) {
        active.activeHandIndex = idx;
        active.status = 'playing';
      } else {
        bjResolveDealerAndHands(active);
      }
    }

    // ---------------------------------------------------------------
    // GET /blackjack/status?discordId=... -> solde + état d'une partie en cours (public)
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/status' && request.method === 'GET') {
      const discordId = (await authedDiscordId(request, env)) || '';
      const config = await getBlackjackConfig(env);
      if (!env.SUBMISSIONS || !discordId) {
        return new Response(JSON.stringify({ keys: 0, active: null }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const balance = await getKeysBalance(env, discordId, config);
      const active = await getBlackjackActiveRound(env, discordId);
      const todayBj = new Date().toISOString().slice(0, 10);
      return new Response(JSON.stringify({
        keys: balance.keys,
        active: active ? bjPublicHandState(active) : null,
        rewards: { daily: balance.lastTopUp !== todayBj, achievements: false },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /blackjack/deal -> mise et distribution des cartes (débite le solde)
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/deal' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const pseudo = String(body.pseudo || '').trim().slice(0, 60);
      const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 300);
      const bet = roundKeys(parseFloat(body.bet));
      if (!discordId || !pseudo || !Number.isFinite(bet) || bet < MIN_BET_KEYS) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_fields' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const userEntryBj = await touchUserDirectory(env, discordId, pseudo, avatarUrl);
      if (userEntryBj.banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // On ne bloque que si une manche est RÉELLEMENT en cours. Une manche déjà
      // résolue (ou trop ancienne) qui serait restée en mémoire suite à un incident
      // réseau bloquait le joueur indéfiniment avec « Une partie est déjà en cours ».
      const existingRound = await getBlackjackActiveRound(env, discordId);
      if (existingRound) {
        const isStale = existingRound.startedAt && (Date.now() - existingRound.startedAt) > 60 * 60 * 1000;
        if (existingRound.status === 'playing' && !isStale) {
          return new Response(JSON.stringify({ ok: false, reason: 'round_in_progress' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        await clearBlackjackActiveRound(env, discordId);
      }
      const config = await getBlackjackConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      if (bet > balance.keys) {
        return new Response(JSON.stringify({ ok: false, reason: 'insufficient_keys', keys: balance.keys }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      balance.keys = roundKeys(balance.keys - bet);

      const deck = bjFreshShuffledDeck();
      const playerCards = [deck.pop(), deck.pop()];
      const dealerCards = [deck.pop(), deck.pop()];
      const hands = [{ cards: playerCards, bet, status: 'active', fromSplit: false }];

      let active = { discordId, pseudo, avatarUrl, deck, dealerCards, hands, activeHandIndex: 0, status: 'playing', startedAt: Date.now() };

      const playerVal = bjHandValue(playerCards);
      const dealerVal = bjHandValue(dealerCards);
      const dealerUpIsAce = dealerCards[0].rank === 'A';
      const dealerUpIsTen = ['10', 'J', 'Q', 'K'].includes(dealerCards[0].rank);

      // Si le croupier montre un As, on ne révèle rien tout de suite : le joueur
      // doit d'abord pouvoir prendre (ou refuser) l'assurance. La manche est mise
      // en pause via canInsure, et /blackjack/insurance la résoudra ensuite.
      if (dealerUpIsAce && !playerVal.blackjack) {
        await saveKeysBalance(env, discordId, balance);
        await saveBlackjackActiveRound(env, discordId, active);
        return new Response(JSON.stringify({ ok: true, keys: balance.keys, state: bjPublicHandState(active) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Blackjack immédiat (joueur et/ou croupier) : on résout tout de suite au lieu
      // de faire jouer le joueur pour rien. Le croupier ne peut avoir un blackjack
      // caché que si sa carte visible est un As (traité au-dessus) ou vaut 10.
      if (playerVal.blackjack || (dealerUpIsTen && dealerVal.blackjack) || (dealerUpIsAce && dealerVal.blackjack)) {
        active.hands[0].status = 'stood';
        bjResolveDealerAndHands(active);
        // Une seule écriture reflétant le débit + le paiement, au lieu de deux
        // (l'un pour la mise, l'autre pour le gain) — économise du quota KV.
        balance.keys = roundKeys(balance.keys + active.totalPayout);
        await saveKeysBalance(env, discordId, balance);
        await addBlackjackPlay(env, {
          id: crypto.randomUUID(), date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', dateMs: Date.now(),
          pseudo, avatarUrl, discordId, bet, result: active.hands[0].result, payout: active.totalPayout, tipped: false, details: bjRoundDetails(active),
        });
        await clearBlackjackActiveRound(env, discordId);
        return new Response(JSON.stringify({ ok: true, keys: balance.keys, state: bjPublicHandState(active) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await saveKeysBalance(env, discordId, balance);
      await saveBlackjackActiveRound(env, discordId, active);
      return new Response(JSON.stringify({ ok: true, keys: balance.keys, state: bjPublicHandState(active) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // Fonction partagée : termine le round si toutes les mains sont jouées,
    // met à jour le solde et l'historique, et renvoie l'état public + le solde.
    // ---------------------------------------------------------------
    async function bjFinishIfResolved(env, discordId, active, config) {
      if (active.status !== 'resolved') {
        await saveBlackjackActiveRound(env, discordId, active);
        return null;
      }
      const balance = await getKeysBalance(env, discordId, config);
      balance.keys = roundKeys(balance.keys + active.totalPayout);
      await saveKeysBalance(env, discordId, balance);
      await clearBlackjackActiveRound(env, discordId);
      const totalBet = active.hands.reduce((s, h) => s + h.bet, 0);
      const overallResult = active.hands.every(h => h.result === 'lose') ? 'lose'
        : active.hands.some(h => h.result === 'win' || h.result === 'blackjack') ? 'win' : 'push';
      await addBlackjackPlay(env, {
        id: crypto.randomUUID(), date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', dateMs: Date.now(),
        pseudo: active.pseudo, avatarUrl: active.avatarUrl || '', discordId, bet: totalBet, result: overallResult, payout: active.totalPayout, tipped: false, details: bjRoundDetails(active),
      });
      return balance.keys;
    }

    // ---------------------------------------------------------------
    // POST /blackjack/hit -> tire une carte sur la main active
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/hit' && request.method === 'POST') {
      if (!env.SUBMISSIONS) return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const active = await getBlackjackActiveRound(env, discordId);
      if (!active || active.status !== 'playing') {
        return new Response(JSON.stringify({ ok: false, reason: 'no_active_round' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const hand = active.hands[active.activeHandIndex];
      hand.cards.push(active.deck.pop());
      const val = bjHandValue(hand.cards);
      if (val.bust) hand.status = 'bust';
      bjAdvanceOrResolve(active);

      const config = await getBlackjackConfig(env);
      const newKeys = await bjFinishIfResolved(env, discordId, active, config);
      return new Response(JSON.stringify({ ok: true, keys: newKeys, state: bjPublicHandState(active) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /blackjack/stand -> arrête la main active
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/stand' && request.method === 'POST') {
      if (!env.SUBMISSIONS) return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const active = await getBlackjackActiveRound(env, discordId);
      if (!active || active.status !== 'playing') {
        return new Response(JSON.stringify({ ok: false, reason: 'no_active_round' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      active.hands[active.activeHandIndex].status = 'stood';
      bjAdvanceOrResolve(active);

      const config = await getBlackjackConfig(env);
      const newKeys = await bjFinishIfResolved(env, discordId, active, config);
      return new Response(JSON.stringify({ ok: true, keys: newKeys, state: bjPublicHandState(active) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /blackjack/double -> double la mise de la main active, une seule carte puis arrêt
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/double' && request.method === 'POST') {
      if (!env.SUBMISSIONS) return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const active = await getBlackjackActiveRound(env, discordId);
      if (!active || active.status !== 'playing') {
        return new Response(JSON.stringify({ ok: false, reason: 'no_active_round' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const hand = active.hands[active.activeHandIndex];
      if (hand.cards.length !== 2) {
        return new Response(JSON.stringify({ ok: false, reason: 'cannot_double' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const config = await getBlackjackConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      if (hand.bet > balance.keys) {
        return new Response(JSON.stringify({ ok: false, reason: 'insufficient_keys', keys: balance.keys }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      balance.keys = roundKeys(balance.keys - hand.bet);
      hand.bet = roundKeys(hand.bet * 2);
      await saveKeysBalance(env, discordId, balance);

      hand.cards.push(active.deck.pop());
      const val = bjHandValue(hand.cards);
      hand.status = val.bust ? 'bust' : 'stood';
      bjAdvanceOrResolve(active);

      const newKeys = await bjFinishIfResolved(env, discordId, active, config);
      return new Response(JSON.stringify({ ok: true, keys: newKeys != null ? newKeys : balance.keys, state: bjPublicHandState(active) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /blackjack/insurance -> le joueur prend (ou refuse) l'assurance quand
    // le croupier montre un As. Coût = moitié de la mise. Paie 2:1 si le croupier
    // a un blackjack (auquel cas la manche est résolue immédiatement).
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/insurance' && request.method === 'POST') {
      if (!env.SUBMISSIONS) return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const takeInsurance = body.take !== false; // true = prend l'assurance, false = refuse
      const active = await getBlackjackActiveRound(env, discordId);
      if (!active || active.status !== 'playing') {
        return new Response(JSON.stringify({ ok: false, reason: 'no_active_round' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const dealerUpIsAce = active.dealerCards[0] && active.dealerCards[0].rank === 'A';
      const eligible = dealerUpIsAce && !active.insuranceResolved && active.hands.length === 1 &&
        active.hands[0].cards.length === 2 && !active.hands[0].fromSplit && active.hands[0].status === 'active';
      if (!eligible) {
        return new Response(JSON.stringify({ ok: false, reason: 'cannot_insure' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      const config = await getBlackjackConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      active.insuranceResolved = true;

      if (!takeInsurance) {
        // Refus de l'assurance : si le croupier a malgré tout un blackjack, la manche
        // est perdue d'avance — on la résout tout de suite plutôt que de faire jouer
        // le joueur pour rien.
        if (bjHandValue(active.dealerCards).blackjack) {
          active.hands[0].status = 'stood';
          bjResolveDealerAndHands(active);
          balance.keys = roundKeys(balance.keys + active.totalPayout);
          await saveKeysBalance(env, discordId, balance);
          await clearBlackjackActiveRound(env, discordId);
          const totalBetR = active.hands.reduce((s, h) => s + h.bet, 0);
          const overallResultR = active.hands.every(h => h.result === 'lose') ? 'lose'
            : active.hands.some(h => h.result === 'win' || h.result === 'blackjack') ? 'win' : 'push';
          await addBlackjackPlay(env, {
            id: crypto.randomUUID(), date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', dateMs: Date.now(),
            pseudo: active.pseudo, avatarUrl: active.avatarUrl || '', discordId, bet: totalBetR, result: overallResultR, payout: active.totalPayout, tipped: false, details: bjRoundDetails(active),
          });
          return new Response(JSON.stringify({ ok: true, keys: balance.keys, insuranceWon: false, state: bjPublicHandState(active) }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        await saveBlackjackActiveRound(env, discordId, active);
        return new Response(JSON.stringify({ ok: true, keys: balance.keys, state: bjPublicHandState(active) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const insuranceCost = roundKeys(active.hands[0].bet / 2);
      if (insuranceCost > balance.keys) {
        return new Response(JSON.stringify({ ok: false, reason: 'insufficient_keys', keys: balance.keys }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      balance.keys = roundKeys(balance.keys - insuranceCost);
      active.insuranceTaken = true;

      const dealerHasBlackjack = bjHandValue(active.dealerCards).blackjack;
      if (dealerHasBlackjack) {
        // L'assurance paie 2:1 : la mise d'assurance est rendue + 2x le coût (net +2x)
        balance.keys = roundKeys(balance.keys + insuranceCost * 3);
        await saveKeysBalance(env, discordId, balance);
        active.hands[0].status = 'stood';
        bjResolveDealerAndHands(active);
        await clearBlackjackActiveRound(env, discordId);
        const totalBet = active.hands.reduce((s, h) => s + h.bet, 0);
        const overallResult = active.hands.every(h => h.result === 'lose') ? 'lose'
          : active.hands.some(h => h.result === 'win' || h.result === 'blackjack') ? 'win' : 'push';
        await addBlackjackPlay(env, {
          id: crypto.randomUUID(), date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', dateMs: Date.now(),
          pseudo: active.pseudo, avatarUrl: active.avatarUrl || '', discordId, bet: totalBet, result: overallResult, payout: active.totalPayout, tipped: false, details: bjRoundDetails(active),
        });
        return new Response(JSON.stringify({ ok: true, keys: balance.keys, insuranceWon: true, state: bjPublicHandState(active) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Pas de blackjack croupier : assurance perdue, la partie continue
      await saveKeysBalance(env, discordId, balance);
      await saveBlackjackActiveRound(env, discordId, active);
      return new Response(JSON.stringify({ ok: true, keys: balance.keys, insuranceWon: false, state: bjPublicHandState(active) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /blackjack/split -> sépare une paire en 2 mains (un seul split autorisé)
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/split' && request.method === 'POST') {
      if (!env.SUBMISSIONS) return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const active = await getBlackjackActiveRound(env, discordId);
      if (!active || active.status !== 'playing') {
        return new Response(JSON.stringify({ ok: false, reason: 'no_active_round' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const hand = active.hands[active.activeHandIndex];
      const canSplit = active.hands.length === 1 && !hand.fromSplit && hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank;
      if (!canSplit) {
        return new Response(JSON.stringify({ ok: false, reason: 'cannot_split' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const config = await getBlackjackConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      if (hand.bet > balance.keys) {
        return new Response(JSON.stringify({ ok: false, reason: 'insufficient_keys', keys: balance.keys }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      balance.keys = roundKeys(balance.keys - hand.bet);
      await saveKeysBalance(env, discordId, balance);

      const cardA = hand.cards[0], cardB = hand.cards[1];
      const handA = { cards: [cardA, active.deck.pop()], bet: hand.bet, status: 'active', fromSplit: true };
      const handB = { cards: [cardB, active.deck.pop()], bet: hand.bet, status: 'active', fromSplit: true };
      active.hands = [handA, handB];
      active.activeHandIndex = 0;

      // Sauvegarde indispensable : sans ça, la partie relisait l'ancien état à une
      // seule main au coup suivant (le split semblait « annulé » après un Hit).
      await saveBlackjackActiveRound(env, discordId, active);

      return new Response(JSON.stringify({ ok: true, keys: balance.keys, state: bjPublicHandState(active) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /blackjack/history?limit=10 -> historique PUBLIC
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/history' && request.method === 'GET') {
      if (!env.SUBMISSIONS) return new Response(JSON.stringify({ history: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 10, 50);
      const plays = await getGamePlays(env, 'blackjack');
      const history = plays.slice(-limit).reverse().map(p => ({
        id: p.id, pseudo: p.pseudo, avatarUrl: p.avatarUrl || '', bet: p.bet, result: p.result, payout: p.payout, date: p.date, dateMs: p.dateMs, details: p.details || null,
      }));
      return new Response(JSON.stringify({ history }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---------------------------------------------------------------
    // GET /blackjack/my-history?discordId=...&limit=10 -> historique PERSONNEL
    // ---------------------------------------------------------------
    if (url.pathname === '/blackjack/my-history' && request.method === 'GET') {
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.SUBMISSIONS || !discordId) return new Response(JSON.stringify({ history: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 10, 50);
      const plays = await getGamePlays(env, 'blackjack');
      const history = plays.filter(p => p.discordId === discordId).slice(-limit).reverse().map(p => ({
        id: p.id, pseudo: p.pseudo, avatarUrl: p.avatarUrl || '', bet: p.bet, result: p.result, payout: p.payout, date: p.date, dateMs: p.dateMs, details: p.details || null,
      }));
      return new Response(JSON.stringify({ history }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // =================================================================
    // DICE — jeu instantané (pas de partie en plusieurs étapes comme Mines/
    // Blackjack) : on choisit une cible et un sens (under/over), le serveur
    // tire un nombre 0.00-99.99 et calcule le multiplicateur en fonction de
    // la chance de gain réelle. Même monnaie "clés" que Mines/Blackjack.
    // =================================================================
    const DICE_HOUSE_EDGE = 0.97;
    // Plancher : au-delà de ~97% de chance, la formule donnait un multiplicateur
    // inférieur à 1 (ex : 0.99x), donc gagner faisait quand même perdre des clés.
    const DICE_MIN_MULTIPLIER = 1.01;

    async function addDicePlay(env, entry) {
      await addLifetimeWager(env, entry, 'dice');
      if (env.VAULT_DB) {
        try {
          await insertGamePlay(env, 'dice', entry);
          return;
        } catch (e) {
          console.warn('Insertion D1 de la partie dice échouée, repli KV :', e.message);
        }
      }
      // Repli si D1 indisponible (comportement historique, tronqué et sujet à la race condition connue)
      const raw = await env.SUBMISSIONS.get('dice_plays');
      const plays = raw ? JSON.parse(raw) : [];
      plays.push(entry);
      try {
        await env.SUBMISSIONS.put('dice_plays', JSON.stringify(plays.slice(-1000)));
      } catch (e) {
        console.warn('Historique dice_plays non enregistré (écritures concurrentes) :', e.message);
      }
    }

    // ---------------------------------------------------------------
    // POST /dice/roll -> mise + tirage instantané (public)
    // ---------------------------------------------------------------
    if (url.pathname === '/dice/roll' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const pseudo = String(body.pseudo || '').trim().slice(0, 60);
      const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 300);
      const bet = roundKeys(parseFloat(body.bet));
      const direction = body.direction === 'over' ? 'over' : 'under';
      let target = parseFloat(body.target);
      if (!Number.isFinite(target)) target = 50;
      target = Math.min(98, Math.max(2, target));

      if (!discordId || !pseudo || !Number.isFinite(bet) || bet < MIN_BET_KEYS) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_fields' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const diceUserEntry = await touchUserDirectory(env, discordId, pseudo, avatarUrl);
      if (diceUserEntry.banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const config = await getKeysConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      if (bet > balance.keys) {
        return new Response(JSON.stringify({ ok: false, reason: 'insufficient_keys', keys: balance.keys }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const winChance = direction === 'under' ? target : (100 - target);
      const multiplier = roundKeys(Math.max(DICE_MIN_MULTIPLIER, (100 / winChance) * DICE_HOUSE_EDGE));
      const roll = Math.round(Math.random() * 9999) / 100; // 0.00 à 99.99
      const won = direction === 'under' ? roll < target : roll > target;
      const payout = won ? roundKeys(bet * multiplier) : 0;

      balance.keys = roundKeys(balance.keys - bet + payout);
      await saveKeysBalance(env, discordId, balance);

      await addDicePlay(env, {
        id: crypto.randomUUID(),
        date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        dateMs: Date.now(),
        pseudo, avatarUrl, discordId, bet,
        won, multiplier, payout, roll, target, direction,
        tipped: false,
      });

      return new Response(JSON.stringify({ ok: true, roll, won, multiplier, payout, keys: balance.keys }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /dice/history?limit=10 -> historique PUBLIC
    // GET /dice/my-history?discordId=...&limit=10 -> historique PERSONNEL
    // ---------------------------------------------------------------
    if ((url.pathname === '/dice/history' || url.pathname === '/dice/my-history') && request.method === 'GET') {
      const isMine = url.pathname === '/dice/my-history';
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.SUBMISSIONS || (isMine && !discordId)) {
        return new Response(JSON.stringify({ history: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 10, 50);
      let plays = await getGamePlays(env, 'dice');
      if (isMine) plays = plays.filter(p => p.discordId === discordId);
      const history = plays.slice(-limit).reverse().map(p => ({
        id: p.id, pseudo: p.pseudo, avatarUrl: p.avatarUrl || '', bet: p.bet, won: p.won,
        multiplier: p.multiplier, payout: p.payout, date: p.date, dateMs: p.dateMs,
        details: { roll: p.roll, target: p.target, direction: p.direction, symbols: p.symbols },
      }));
      return new Response(JSON.stringify({ history }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // =================================================================
    // SLOTS — nouvelle machine à sous en clés (distincte de l'ancienne
    // /slot/play en $, conservée pour la popup existante sur index/vault).
    // Résolution instantanée comme Dice : mise, tirage, résultat, terminé.
    // =================================================================
    async function getSlotsConfig(env) {
      if (!env.SUBMISSIONS) return { winChancePercent: 45, winMultiplier: 2 };
      const raw = await env.SUBMISSIONS.get('slots_config');
      const config = raw ? JSON.parse(raw) : {};
      if (typeof config.winChancePercent !== 'number') config.winChancePercent = 45;
      if (typeof config.winMultiplier !== 'number') config.winMultiplier = 2;
      return config;
    }

    async function addSlotsPlay(env, entry) {
      await addLifetimeWager(env, entry, 'slots');
      if (env.VAULT_DB) {
        try {
          await insertGamePlay(env, 'slots', entry);
          return;
        } catch (e) {
          console.warn('Insertion D1 de la partie slots échouée, repli KV :', e.message);
        }
      }
      // Repli si D1 indisponible (comportement historique, tronqué et sujet à la race condition connue)
      const raw = await env.SUBMISSIONS.get('slots_plays');
      const plays = raw ? JSON.parse(raw) : [];
      plays.push(entry);
      try {
        await env.SUBMISSIONS.put('slots_plays', JSON.stringify(plays.slice(-1000)));
      } catch (e) {
        console.warn('Historique slots_plays non enregistré (écritures concurrentes) :', e.message);
      }
    }

    const SLOTS_LOSE_SYMBOLS = ['🍒', '🔔', '🍋', '⭐', '💎'];
    function slotsRandomLosingSet() {
      // 3 symboles dont au moins 2 différents, pour ne jamais afficher un faux "3 identiques"
      let a = SLOTS_LOSE_SYMBOLS[Math.floor(Math.random() * SLOTS_LOSE_SYMBOLS.length)];
      let b = SLOTS_LOSE_SYMBOLS[Math.floor(Math.random() * SLOTS_LOSE_SYMBOLS.length)];
      while (b === a) b = SLOTS_LOSE_SYMBOLS[Math.floor(Math.random() * SLOTS_LOSE_SYMBOLS.length)];
      const c = SLOTS_LOSE_SYMBOLS[Math.floor(Math.random() * SLOTS_LOSE_SYMBOLS.length)];
      return [a, b, c];
    }

    // ---------------------------------------------------------------
    // POST /slots/spin -> mise + tirage instantané (public)
    // ---------------------------------------------------------------
    if (url.pathname === '/slots/spin' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const pseudo = String(body.pseudo || '').trim().slice(0, 60);
      const avatarUrl = String(body.avatarUrl || '').trim().slice(0, 300);
      const bet = roundKeys(parseFloat(body.bet));
      if (!discordId || !pseudo || !Number.isFinite(bet) || bet < MIN_BET_KEYS) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_fields' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const slotsUserEntry = await touchUserDirectory(env, discordId, pseudo, avatarUrl);
      if (slotsUserEntry.banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const keysConfig = await getKeysConfig(env);
      const balance = await getKeysBalance(env, discordId, keysConfig);
      if (bet > balance.keys) {
        return new Response(JSON.stringify({ ok: false, reason: 'insufficient_keys', keys: balance.keys }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const slotsConfig = await getSlotsConfig(env);
      const won = Math.random() * 100 < slotsConfig.winChancePercent;
      const symbols = won ? ['7️⃣', '7️⃣', '7️⃣'] : slotsRandomLosingSet();
      const payout = won ? roundKeys(bet * slotsConfig.winMultiplier) : 0;

      balance.keys = roundKeys(balance.keys - bet + payout);
      await saveKeysBalance(env, discordId, balance);

      await addSlotsPlay(env, {
        id: crypto.randomUUID(),
        date: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
        dateMs: Date.now(),
        pseudo, avatarUrl, discordId, bet,
        won, multiplier: slotsConfig.winMultiplier, payout, symbols,
        tipped: false,
      });

      return new Response(JSON.stringify({ ok: true, won, symbols, multiplier: slotsConfig.winMultiplier, payout, keys: balance.keys }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /slots/history?limit=10 -> historique PUBLIC
    // GET /slots/my-history?discordId=...&limit=10 -> historique PERSONNEL
    // ---------------------------------------------------------------
    if ((url.pathname === '/slots/history' || url.pathname === '/slots/my-history') && request.method === 'GET') {
      const isMine = url.pathname === '/slots/my-history';
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.SUBMISSIONS || (isMine && !discordId)) {
        return new Response(JSON.stringify({ history: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 10, 50);
      let plays = await getGamePlays(env, 'slots');
      if (isMine) plays = plays.filter(p => p.discordId === discordId);
      const history = plays.slice(-limit).reverse().map(p => ({
        id: p.id, pseudo: p.pseudo, avatarUrl: p.avatarUrl || '', bet: p.bet, won: p.won,
        multiplier: p.multiplier, payout: p.payout, date: p.date, dateMs: p.dateMs,
        details: { roll: p.roll, target: p.target, direction: p.direction, symbols: p.symbols },
      }));
      return new Response(JSON.stringify({ history }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /slots/admin-state / POST /slots/set -> réglages (chance + multiplicateur, protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/slots/admin-state' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const config = await getSlotsConfig(env);
      return new Response(JSON.stringify(config), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/slots/set' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const winChancePercent = parseFloat(body.winChancePercent);
      const winMultiplier = parseFloat(body.winMultiplier);
      if (isNaN(winChancePercent) || isNaN(winMultiplier)) {
        return new Response('Valeurs invalides', { status: 400, headers: corsHeaders });
      }
      await env.SUBMISSIONS.put('slots_config', JSON.stringify({ winChancePercent, winMultiplier }));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /leaderboard?limit=22 -> classement par total misé ("wager"), tous
    // jeux confondus (Mines, Blackjack, Dice, Slots). Lecture seule (pas
    // d'écriture), peut être appelée souvent sans impact sur le quota KV.
    // ---------------------------------------------------------------
    if (url.pathname === '/leaderboard' && request.method === 'GET') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ leaderboard: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 22, 100);
      const sortBy = url.searchParams.get('sort') === 'multiplier' ? 'multiplier' : 'wager';
      // Source de vérité : le total lifetime (jamais tronqué), pas les logs
      // *_plays qui ne gardent que les 1000 dernières parties par jeu.
      const totals = await getWagerTotals(env);

      // Corrections manuelles de l'admin (ex : mise gonflée via une faille).
      // Elles s'ajoutent au total calculé sans jamais toucher à l'historique des
      // parties, qui reste intact et consultable.
      const adjustments = await getWagerAdjustments(env);
      const excluded = adjustments.__excluded || {};

      // Un joueur peut avoir une correction sans avoir de parties (rare mais possible)
      for (const discordId of Object.keys(adjustments)) {
        if (discordId === '__excluded') continue;
        if (!totals[discordId]) {
          const dir = await getUserDirectory(env);
          const entry = dir[discordId] || {};
          totals[discordId] = { wager: 0, pseudo: entry.pseudo || '', avatarUrl: entry.avatarUrl || '' };
        }
      }

      const list = Object.keys(totals)
        .filter(discordId => !excluded[discordId])
        .map(discordId => {
          const rawWager = roundKeys(totals[discordId].wager);
          const adjustment = roundKeys(adjustments[discordId] || 0);
          return {
            discordId,
            pseudo: totals[discordId].pseudo,
            avatarUrl: totals[discordId].avatarUrl,
            rawWager,
            adjustment,
            wager: roundKeys(Math.max(0, rawWager + adjustment)),
            bestMultiplier: roundKeys(totals[discordId].bestMultiplier || 0),
            bestMultiplierGame: totals[discordId].bestMultiplierGame || '',
          };
        });
      if (sortBy === 'multiplier') {
        list.sort((a, b) => b.bestMultiplier - a.bestMultiplier);
      } else {
        list.sort((a, b) => b.wager - a.wager);
      }
      return new Response(JSON.stringify({ leaderboard: list.slice(0, limit), sort: sortBy }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /leaderboard/streaks -> classement par série de connexion
    // quotidienne. Une série non réclamée hier ou aujourd'hui est traitée
    // comme cassée (0) même si la valeur stockée est plus ancienne — sinon
    // quelqu'un qui a arrêté de venir resterait affiché en haut du classement
    // indéfiniment.
    // ---------------------------------------------------------------
    if (url.pathname === '/leaderboard/streaks' && request.method === 'GET') {
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ leaderboard: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 22, 100);
      await ensureStreakTable(env);
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

      const adjustments = await getWagerAdjustments(env);
      const excluded = adjustments.__excluded || {};

      const { results } = await env.VAULT_DB.prepare('SELECT * FROM player_streaks').all();
      const list = (results || [])
        .filter(row => !excluded[row.discordId])
        .map(row => ({
          discordId: row.discordId,
          pseudo: row.pseudo,
          avatarUrl: row.avatarUrl,
          streak: (row.lastTopUp === today || row.lastTopUp === yesterday) ? (row.streak || 0) : 0,
        }))
        .filter(row => row.streak > 0)
        .sort((a, b) => b.streak - a.streak);

      return new Response(JSON.stringify({ leaderboard: list.slice(0, limit) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /admin/backfill-wager-totals -> initialise wager_totals à partir des
    // logs *_plays existants (protégé). À appeler UNE SEULE FOIS juste après le
    // déploiement de cette version, pour que le classement ne reparte pas de
    // zéro. Par défaut, ne touche jamais un joueur qui a déjà une entrée dans
    // wager_totals (idempotent, sans danger si relancé par erreur) ; passer
    // { "force": true } pour écraser malgré tout (à éviter une fois le nouveau
    // système en production, car les logs sont tronqués à 1000 et donneraient
    // alors un total plus BAS que la valeur réelle déjà accumulée).
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/backfill-wager-totals' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const force = !!body.force;

      const gameNames = ['mines', 'blackjack', 'dice', 'slots'];
      const fromLogs = {};
      for (const gameName of gameNames) {
        const plays = await getGamePlays(env, gameName);
        for (const p of plays) {
          if (!p.discordId) continue;
          if (!fromLogs[p.discordId]) {
            fromLogs[p.discordId] = {
              wager: 0, plays: 0, pseudo: p.pseudo || '', avatarUrl: p.avatarUrl || '',
              won: 0, bestMultiplier: 0, bestMultiplierGame: '', bestMultiplierDate: '', biggestBet: 0,
            };
          }
          const t = fromLogs[p.discordId];
          const bet = parseFloat(p.bet) || 0;
          const payout = p.busted ? 0 : (parseFloat(p.payout) || 0);
          let mult = 0;
          if (gameName === 'mines') mult = p.busted ? 0 : (parseFloat(p.multiplier) || 0);
          else if (bet > 0) mult = payout / bet;

          t.wager += bet;
          t.plays += 1;
          t.won += payout;
          if (bet > t.biggestBet) t.biggestBet = bet;
          if (mult > t.bestMultiplier) {
            t.bestMultiplier = mult;
            t.bestMultiplierGame = gameName;
            t.bestMultiplierDate = p.date || '';
          }
          if (p.pseudo) t.pseudo = p.pseudo;
          if (p.avatarUrl) t.avatarUrl = p.avatarUrl;
        }
      }

      const totals = await getWagerTotals(env);
      let seeded = 0, skipped = 0;
      for (const discordId of Object.keys(fromLogs)) {
        if (totals[discordId] && !force) { skipped++; continue; }
        totals[discordId] = {
          wager: roundKeys(fromLogs[discordId].wager),
          plays: fromLogs[discordId].plays,
          pseudo: fromLogs[discordId].pseudo,
          avatarUrl: fromLogs[discordId].avatarUrl,
          won: roundKeys(fromLogs[discordId].won),
          bestMultiplier: fromLogs[discordId].bestMultiplier,
          bestMultiplierGame: fromLogs[discordId].bestMultiplierGame,
          bestMultiplierDate: fromLogs[discordId].bestMultiplierDate,
          biggestBet: roundKeys(fromLogs[discordId].biggestBet),
        };
        seeded++;
      }
      await saveWagerTotals(env, totals);
      return new Response(JSON.stringify({ ok: true, seeded, skipped, totalPlayers: Object.keys(totals).length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /admin/migrate-submissions-to-d1 -> importe l'ancien blob KV
    // "all_submissions" dans la table D1 "submissions" (protégé). À appeler
    // UNE SEULE FOIS après le déploiement de cette version, pour que
    // l'historique existant apparaisse toujours dans le dashboard. Sans danger
    // si relancé par erreur : INSERT OR IGNORE ne duplique jamais une ligne
    // dont l'id existe déjà.
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/migrate-submissions-to-d1' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response('Base D1 non configurée (binding VAULT_DB manquant sur le Worker)', { status: 500, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: true, migrated: 0, note: 'Aucun ancien blob KV à migrer.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureSubmissionsTable(env);
      const raw = await env.SUBMISSIONS.get('all_submissions');
      const oldEntries = raw ? JSON.parse(raw) : [];
      let migrated = 0, skipped = 0;
      for (const entry of oldEntries) {
        if (!entry.id) continue;
        try {
          await env.VAULT_DB.prepare(`
            INSERT OR IGNORE INTO submissions (id, date, dateMs, platform, code, pseudo, email, discordId, deviceId, ip, country, tipped, archived, status, statusAt, declineReason, declineNote)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            entry.id, entry.date || '', entry.dateMs || 0, entry.platform || '', entry.code || '',
            entry.pseudo || '', entry.email || '', entry.discordId || '', entry.deviceId || '',
            entry.ip || '', entry.country || '', entry.tipped ? 1 : 0, entry.archived ? 1 : 0,
            entry.status || 'pending', entry.statusAt || entry.dateMs || 0,
            entry.declineReason || '', entry.declineNote || ''
          ).run();
          migrated++;
        } catch (e) {
          skipped++;
        }
      }
      const { results } = await env.VAULT_DB.prepare('SELECT COUNT(*) as c FROM submissions').all();
      return new Response(JSON.stringify({
        ok: true, migrated, skipped, totalInD1: results[0].c, totalInOldKV: oldEntries.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /admin/migrate-wager-totals-to-d1 -> importe l'ancien blob KV
    // "wager_totals" dans la table D1 "wager_totals" (protégé). À appeler UNE
    // SEULE FOIS après le déploiement de cette version, pour que le classement
    // ne reparte pas de zéro. Sans danger si relancé par erreur : chaque ligne
    // est simplement réécrite avec la même valeur (INSERT OR REPLACE), jamais
    // dupliquée ni incrémentée deux fois.
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/migrate-wager-totals-to-d1' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response('Base D1 non configurée (binding VAULT_DB manquant sur le Worker)', { status: 500, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: true, migrated: 0, note: 'Aucun ancien blob KV à migrer.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureWagerTotalsTable(env);
      const raw = await env.SUBMISSIONS.get('wager_totals');
      const oldTotals = raw ? JSON.parse(raw) : {};
      let migrated = 0, skipped = 0;
      for (const [discordId, t] of Object.entries(oldTotals)) {
        if (!discordId) continue;
        try {
          await env.VAULT_DB.prepare(`
            INSERT INTO wager_totals (discordId, wager, plays, pseudo, avatarUrl)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(discordId) DO UPDATE SET
              wager = excluded.wager, plays = excluded.plays,
              pseudo = excluded.pseudo, avatarUrl = excluded.avatarUrl
          `).bind(discordId, t.wager || 0, t.plays || 0, t.pseudo || '', t.avatarUrl || '').run();
          migrated++;
        } catch (e) {
          skipped++;
        }
      }
      const { results: r2 } = await env.VAULT_DB.prepare('SELECT COUNT(*) as c FROM wager_totals').all();
      return new Response(JSON.stringify({
        ok: true, migrated, skipped, totalInD1: r2[0].c, totalInOldKV: Object.keys(oldTotals).length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /admin/migrate-streaks-to-d1 -> parcourt les soldes individuels
    // existants (mines_balance_<id>) et remplit le classement de série D1.
    // À appeler UNE SEULE FOIS après le déploiement de cette version. Sans
    // danger si relancé : chaque ligne est simplement réécrite.
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/migrate-streaks-to-d1' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response('Base D1 non configurée (binding VAULT_DB manquant sur le Worker)', { status: 500, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: true, migrated: 0, note: 'Aucun solde à migrer.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureStreakTable(env);
      const dir = await getUserDirectory(env);

      let migrated = 0, skipped = 0, cursor = undefined;
      do {
        const page = await env.SUBMISSIONS.list({ prefix: 'mines_balance_', cursor });
        for (const key of page.keys) {
          const discordId = key.name.slice('mines_balance_'.length);
          if (!discordId) continue;
          try {
            const raw = await env.SUBMISSIONS.get(key.name);
            const balance = raw ? JSON.parse(raw) : null;
            if (!balance || !balance.streak) continue;
            const entry = dir[discordId] || {};
            await upsertStreak(env, discordId, entry.pseudo || '', entry.avatarUrl || '', balance.streak, balance.lastTopUp || '');
            migrated++;
          } catch (e) {
            skipped++;
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);

      const { results: r3 } = await env.VAULT_DB.prepare('SELECT COUNT(*) as c FROM player_streaks').all();
      return new Response(JSON.stringify({ ok: true, migrated, skipped, totalInD1: r3[0].c }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /admin/broadcast-dm/preview -> nombre de personnes uniques qui
    // recevraient le message (tipsé OU refusé, dédupliqué par Discord ID).
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/broadcast-dm/preview' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      const all = await getAllSubmissions(env);
      const uniqueIds = new Set(
        all.filter(s => (s.status === 'sent' || s.status === 'declined') && s.discordId).map(s => s.discordId)
      );
      return new Response(JSON.stringify({ ok: true, count: uniqueIds.size }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- Historique des diffusions (envoyés/échoués/clics réels — jamais
    // d'"ouvertures", Discord ne donne aucune information là-dessus aux bots) ----
    async function ensureBroadcastsTable(env) {
      await env.VAULT_DB.prepare(`
        CREATE TABLE IF NOT EXISTS broadcasts (
          id TEXT PRIMARY KEY,
          message TEXT,
          dateMs INTEGER,
          totalRecipients INTEGER DEFAULT 0,
          sent INTEGER DEFAULT 0,
          failed INTEGER DEFAULT 0,
          clicks INTEGER DEFAULT 0,
          status TEXT DEFAULT 'processing',
          failureDetails TEXT DEFAULT '[]'
        )
      `).run();
      // Ajoute les colonnes si la table existait déjà sans elles (mise à jour en place)
      try {
        await env.VAULT_DB.prepare(`ALTER TABLE broadcasts ADD COLUMN status TEXT DEFAULT 'processing'`).run();
      } catch (e) { /* déjà présente, normal */ }
      try {
        await env.VAULT_DB.prepare(`ALTER TABLE broadcasts ADD COLUMN failureDetails TEXT DEFAULT '[]'`).run();
      } catch (e) { /* déjà présente, normal */ }
    }

    // Remplace tout lien drop-cash.com du message par une version traçable
    // (?bc=<id>, ou &bc=<id> s'il y a déjà des paramètres), pour compter les
    // vrais clics sans changer la destination du lien.
    function addClickTracking(message, broadcastId) {
      return message.replace(/https:\/\/drop-cash\.com([^\s]*)/g, (match, rest) => {
        const hasQuery = rest.includes('?');
        const separator = hasQuery ? '&' : '?';
        return `https://drop-cash.com${rest}${separator}bc=${broadcastId}`;
      });
    }

    if (url.pathname === '/admin/broadcasts' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ broadcasts: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureBroadcastsTable(env);
      const { results } = await env.VAULT_DB.prepare('SELECT * FROM broadcasts ORDER BY dateMs DESC LIMIT 50').all();
      return new Response(JSON.stringify({ broadcasts: results || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /track/click -> public, appelé depuis la page quand ?bc=<id> est
    // présent dans l'URL. Incrémente le compteur de clics du message concerné.
    if (url.pathname === '/track/click' && request.method === 'POST') {
      if (!env.VAULT_DB) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) { body = {}; }
      const broadcastId = body.broadcastId || '';
      if (broadcastId) {
        try {
          await ensureBroadcastsTable(env);
          await env.VAULT_DB.prepare('UPDATE broadcasts SET clicks = clicks + 1 WHERE id = ?').bind(broadcastId).run();
        } catch (e) { /* silencieux, un compteur de clics ne doit jamais faire échouer la navigation */ }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /admin/broadcast-dm -> renvoie un message à TOUS les membres ayant
    // déjà reçu un DM du bot (demande tipsée ou refusée), une seule fois
    // chacun même s'ils ont plusieurs demandes. Envoi espacé (respect des
    // limites de débit Discord), jamais tout d'un coup. Un échec individuel
    // (DM fermés, bot bloqué) n'interrompt jamais le reste de l'envoi.
    // Plafonné à 300 destinataires par appel — au-delà, relancer plus tard
    // couvre le reste (aucun risque de doublon, chaque envoi est isolé).
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/broadcast-dm' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const rawMessage = (body.message || '').trim();
      if (!rawMessage) {
        return new Response('Message vide', { status: 400, headers: corsHeaders });
      }
      const broadcastId = crypto.randomUUID();
      const message = addClickTracking(rawMessage, broadcastId);

      const all = await getAllSubmissions(env);
      const seen = new Set();
      const recipients = [];
      for (const s of all) {
        if ((s.status === 'sent' || s.status === 'declined') && s.discordId && !seen.has(s.discordId)) {
          seen.add(s.discordId);
          recipients.push({ discordId: s.discordId, pseudo: s.pseudo || '' });
        }
      }
      const batch = recipients.slice(0, 300);

      // Ligne d'historique créée TOUT DE SUITE, avant le moindre envoi — donc
      // même si le navigateur se ferme, change de page, ou perd la connexion
      // pendant l'envoi (qui prend volontairement du temps, espacé pour
      // respecter les limites Discord), une trace existe déjà. Le statut
      // passera à "done" une fois tous les destinataires traités.
      if (env.VAULT_DB) {
        try {
          await ensureBroadcastsTable(env);
          await env.VAULT_DB.prepare(`
            INSERT INTO broadcasts (id, message, dateMs, totalRecipients, sent, failed, clicks, status)
            VALUES (?, ?, ?, ?, 0, 0, 0, 'processing')
          `).bind(broadcastId, rawMessage, Date.now(), recipients.length).run();
        } catch (e) { /* on continue quand même l'envoi si l'écriture initiale échoue */ }
      }

      // L'envoi réel continue EN ARRIÈRE-PLAN via ctx.waitUntil : il tourne
      // côté serveur indépendamment de la connexion du navigateur qui a
      // déclenché la requête. Fermer l'onglet, changer de page, perdre le
      // wifi — rien de tout ça n'interrompt l'envoi une fois lancé.
      async function processBroadcast() {
        let sent = 0;
        const failures = [];
        for (const r of batch) {
          try {
            await sendDiscordDM(r.discordId, message, env);
            sent++;
          } catch (err) {
            failures.push({ discordId: r.discordId, pseudo: r.pseudo, error: err.message });
          }
          await new Promise(resolve => setTimeout(resolve, 450));
        }
        if (env.VAULT_DB) {
          try {
            await ensureBroadcastsTable(env);
            await env.VAULT_DB.prepare(
              `UPDATE broadcasts SET sent = ?, failed = ?, status = 'done', failureDetails = ? WHERE id = ?`
            ).bind(sent, failures.length, JSON.stringify(failures), broadcastId).run();
          } catch (e) { /* l'envoi est déjà parti, on ne peut plus rien faire de plus ici */ }
        }
      }
      ctx.waitUntil(processBroadcast());

      return new Response(JSON.stringify({
        ok: true, broadcastId, totalRecipients: recipients.length, queued: batch.length,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // cette version. Comme chaque blob KV est déjà plafonné à 1000 parties, ça
    // reste rapide (4000 lignes maximum). Sans danger si relancé par erreur :
    // INSERT OR IGNORE ne duplique jamais une partie dont l'id existe déjà.
    // ---------------------------------------------------------------
    if (url.pathname === '/admin/migrate-game-plays-to-d1' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.VAULT_DB) {
        return new Response('Base D1 non configurée (binding VAULT_DB manquant sur le Worker)', { status: 500, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: true, migrated: 0, note: 'Aucun ancien blob KV à migrer.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await ensureGamePlaysTable(env);
      const detail = {};
      let migrated = 0, skipped = 0, totalInOldKV = 0;
      for (const [game, key] of Object.entries(GAME_PLAY_KV_KEYS)) {
        const raw = await env.SUBMISSIONS.get(key);
        const plays = raw ? JSON.parse(raw) : [];
        totalInOldKV += plays.length;
        let gameMigrated = 0;
        for (const p of plays) {
          if (!p.id) continue;
          try {
            await env.VAULT_DB.prepare(
              'INSERT OR IGNORE INTO game_plays (id, game, discordId, dateMs, data) VALUES (?, ?, ?, ?, ?)'
            ).bind(p.id, game, p.discordId || '', p.dateMs || 0, JSON.stringify(p)).run();
            gameMigrated++;
            migrated++;
          } catch (e) {
            skipped++;
          }
        }
        detail[game] = { fromOldKV: plays.length, migrated: gameMigrated };
      }
      const { results: r3 } = await env.VAULT_DB.prepare('SELECT COUNT(*) as c FROM game_plays').all();
      return new Response(JSON.stringify({
        ok: true, migrated, skipped, totalInD1: r3[0].c, totalInOldKV, detail,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /leaderboard/admin -> classement complet avec détail des corrections (protégé)
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // GET /stats/overview -> statistiques globales pour le dashboard (protégé) :
    // clés misées par jour sur 30 jours + totaux par jeu. Lecture seule.
    // ---------------------------------------------------------------
    // =================================================================
    // PROFIL — récompense quotidienne à réclamer, statistiques et succès
    // =================================================================
    const DAILY_KEYS = 2;



    // Renvoie l'état de la récompense du jour sans rien modifier
    function buildClaimState(balance) {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const claimedToday = balance.lastTopUp === today;
      // La série ne compte que si la dernière réclamation date d'hier ou d'aujourd'hui ;
      // un jour manqué la remet à zéro (elle est purement visuelle, sans récompense).
      let streak = balance.streak || 0;
      if (balance.lastTopUp !== today && balance.lastTopUp !== yesterday) streak = 0;
      return { claimedToday, streak, amount: DAILY_KEYS, nextResetUtc: today };
    }

    // ---------------------------------------------------------------
    // GET /profile/summary?discordId=... -> solde, claim du jour, stats, succès
    // ---------------------------------------------------------------
    if (url.pathname === '/profile/summary' && request.method === 'GET') {
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.SUBMISSIONS || !discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_discord' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const config = await getKeysConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      const claim = buildClaimState(balance);

      // --- Parcours de l'historique des 4 jeux pour ce joueur ---
      const gameNamesSummary = ['mines', 'blackjack', 'dice', 'slots'];
      let totalPlays = 0, totalWagered = 0, totalWon = 0;
      let bestMultiplier = 0, bestMultiplierGame = '', bestMultiplierDate = '';
      let biggestBet = 0;
      let hasBlackjack = false, hasSlotJackpot50 = false;
      const gamesPlayed = new Set();
      const perGame = {};
      const recent = [];

      for (const name of gameNamesSummary) {
        const mine = await getGamePlaysByPlayer(env, name, discordId);
        let gWager = 0, gWon = 0;
        for (const p of mine) {
          const bet = parseFloat(p.bet) || 0;
          const payout = p.busted ? 0 : (parseFloat(p.payout) || 0);
          gWager += bet; gWon += payout;
          if (bet > biggestBet) biggestBet = bet;

          // Multiplicateur réellement obtenu sur cette partie
          let mult = 0;
          if (name === 'mines') mult = p.busted ? 0 : (parseFloat(p.multiplier) || 0);
          else if (bet > 0) mult = payout / bet;
          if (mult > bestMultiplier) {
            bestMultiplier = mult;
            bestMultiplierGame = name;
            bestMultiplierDate = p.date || '';
          }

          if (name === 'blackjack' && p.result === 'blackjack') hasBlackjack = true;
          // Jackpot : les trois 7 au Slot avec au moins 50 clés misées
          if (name === 'slots' && p.won && bet >= 50) hasSlotJackpot50 = true;

          recent.push({
            game: name === 'slots' ? 'slot' : name,
            bet, payout, dateMs: p.dateMs || 0,
            won: name === 'mines' ? !p.busted : (name === 'blackjack' ? (p.result === 'win' || p.result === 'blackjack') : !!p.won),
            multiplier: roundKeys(mult),
          });
        }
        if (mine.length) gamesPlayed.add(name);
        totalPlays += mine.length;
        totalWagered += gWager;
        totalWon += gWon;
        perGame[name] = { plays: mine.length, wagered: roundKeys(gWager), won: roundKeys(gWon) };
      }

      recent.sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));

      // --- Stats "à vie" fiables (jamais tronquées), lues depuis D1 ---
      // Le calcul ci-dessus (depuis les logs mines_plays etc., tronqués aux
      // 1000 dernières parties TOUS JOUEURS confondus) sert désormais
      // uniquement de repli si la table D1 n'a rien pour ce joueur (D1
      // indisponible, ou joueur qui vient tout juste de commencer) — mieux
      // vaut un chiffre possiblement tronqué que rien du tout. Dès qu'une
      // ligne D1 existe, elle prime : c'est elle qui reste juste indéfiniment,
      // contrairement au recalcul depuis les logs qui se dégrade avec le temps.
      const lifetime = await getPlayerLifetimeStats(env, discordId);
      if (lifetime) {
        totalPlays = lifetime.plays;
        totalWagered = lifetime.wager;
        totalWon = lifetime.won;
        bestMultiplier = lifetime.bestMultiplier;
        bestMultiplierGame = lifetime.bestMultiplierGame;
        bestMultiplierDate = lifetime.bestMultiplierDate;
        biggestBet = lifetime.biggestBet;
      }

      // --- Succès (tous déduits de l'historique, rien de stocké en plus) ---
      // Succès déjà réclamés : stockés à part pour qu'une récompense ne puisse
      // être encaissée qu'une seule fois par joueur.
      const claimedAch = await getClaimedAchievements(env, discordId);

      const achievements = ACHIEVEMENT_DEFS.map(def => ({
        id: def.id, icon: def.icon, name: def.name, desc: def.desc,
        reward: def.reward,
        unlocked: def.test({ totalPlays, biggestBet, bestMultiplier, hasBlackjack, hasSlotJackpot50, gamesPlayed }),
        claimed: !!claimedAch[def.id],
      }));
      const claimableKeys = roundKeys(
        achievements.filter(a => a.unlocked && !a.claimed).reduce((s, a) => s + a.reward, 0)
      );

      const dir = await getUserDirectory(env);
      const entry = dir[discordId] || {};

      return new Response(JSON.stringify({
        ok: true,
        keys: roundKeys(balance.keys || 0),
        claim,
        profile: {
          pseudo: entry.pseudo || '',
          avatarUrl: entry.avatarUrl || '',
          banned: !!entry.banned,
        },
        stats: {
          plays: totalPlays,
          wagered: roundKeys(totalWagered),
          won: roundKeys(totalWon),
          net: roundKeys(totalWon - totalWagered),
          bestMultiplier: roundKeys(bestMultiplier),
          bestMultiplierGame,
          bestMultiplierDate,
          biggestBet: roundKeys(biggestBet),
          perGame,
        },
        achievements,
        claimableKeys,
        recent: recent.slice(0, 8),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---------------------------------------------------------------
    // POST /profile/claim -> réclame les clés du jour (une fois par jour)
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // POST /profile/claim-achievements -> encaisse les succès débloqués
    // Les conditions sont RECALCULÉES ici : on ne fait jamais confiance au
    // navigateur pour décider qu'un succès est acquis.
    // ---------------------------------------------------------------
    // ---------------------------------------------------------------
    // GET /profile/bonus-requests?discordId=... -> suivi des demandes de bonus
    // du joueur (section "Bonus tracking" de sa page Profil).
    // ---------------------------------------------------------------
    if (url.pathname === '/profile/bonus-requests' && request.method === 'GET') {
      const discordId = (await authedDiscordId(request, env)) || '';
      if (!env.SUBMISSIONS || !discordId) {
        return new Response(JSON.stringify({ requests: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const all = await getAllSubmissions(env);
      const mine = all
        .filter(s => s.discordId === discordId)
        .slice(-20)
        .reverse()
        .map(s => ({
          id: s.id,
          platform: s.platform,
          code: s.code,
          dateMs: s.dateMs,
          // Les demandes d'avant cette fonctionnalité n'ont pas de statut :
          // on se rabat sur l'indicateur "tipped" pour rester cohérent.
          status: s.status || (s.tipped ? 'sent' : 'pending'),
          statusAt: s.statusAt || s.dateMs,
          declineReason: s.declineReason || '',
          declineNote: s.declineNote || '',
        }));
      return new Response(JSON.stringify({ requests: mine }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/profile/claim-achievements' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (!discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_discord' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const dirAch = await getUserDirectory(env);
      if (dirAch[discordId] && dirAch[discordId].banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Recalcule les statistiques du joueur depuis l'historique
      const gameNamesAch = ['mines', 'blackjack', 'dice', 'slots'];
      let totalPlays = 0, biggestBet = 0, bestMultiplier = 0;
      let hasBlackjack = false, hasSlotJackpot50 = false;
      const gamesPlayed = new Set();

      for (const name of gameNamesAch) {
        const mine = await getGamePlaysByPlayer(env, name, discordId);
        if (mine.length) gamesPlayed.add(name);
        totalPlays += mine.length;
        for (const p of mine) {
          const bet = parseFloat(p.bet) || 0;
          const payout = p.busted ? 0 : (parseFloat(p.payout) || 0);
          if (bet > biggestBet) biggestBet = bet;
          let mult = 0;
          if (name === 'mines') mult = p.busted ? 0 : (parseFloat(p.multiplier) || 0);
          else if (bet > 0) mult = payout / bet;
          if (mult > bestMultiplier) bestMultiplier = mult;
          if (name === 'blackjack' && p.result === 'blackjack') hasBlackjack = true;
          if (name === 'slots' && p.won && bet >= 50) hasSlotJackpot50 = true;
        }
      }

      // Le calcul ci-dessus (depuis les logs mines_plays etc., tronqués aux
      // 1000 dernières parties TOUS JOUEURS confondus) sert désormais de repli
      // seulement. C'est ce qui causait le bug "Nothing to claim" : un joueur
      // pouvait voir "550 parties" sur son profil (source fiable, D1) mais se
      // faire recalculer un total plus bas ici (logs tronqués), l'empêchant de
      // réclamer un succès pourtant déjà mérité. hasBlackjack/hasSlotJackpot50/
      // gamesPlayed restent basés sur les logs (pas encore suivis dans D1).
      const lifetimeAch = await getPlayerLifetimeStats(env, discordId);
      if (lifetimeAch) {
        totalPlays = lifetimeAch.plays;
        bestMultiplier = lifetimeAch.bestMultiplier;
        biggestBet = lifetimeAch.biggestBet;
      }

      const stats = { totalPlays, biggestBet, bestMultiplier, hasBlackjack, hasSlotJackpot50, gamesPlayed };
      const claimed = await getClaimedAchievements(env, discordId);
      const newlyClaimed = [];
      let total = 0;

      for (const def of ACHIEVEMENT_DEFS) {
        if (claimed[def.id]) continue;
        if (!def.test(stats)) continue;
        claimed[def.id] = Date.now();
        newlyClaimed.push({ id: def.id, name: def.name, reward: def.reward });
        total += def.reward;
      }

      if (!newlyClaimed.length) {
        return new Response(JSON.stringify({ ok: false, reason: 'nothing_to_claim' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const configAch = await getKeysConfig(env);
      const balanceAch = await getKeysBalance(env, discordId, configAch);
      balanceAch.keys = roundKeys((balanceAch.keys || 0) + total);
      await saveKeysBalance(env, discordId, balanceAch);
      await saveClaimedAchievements(env, discordId, claimed);

      return new Response(JSON.stringify({
        ok: true,
        claimed: newlyClaimed,
        total: roundKeys(total),
        keys: balanceAch.keys,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/profile/claim' && request.method === 'POST') {
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const discordId = await authedDiscordId(request, env);
      if (!discordId) return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      if (!discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_discord' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Alimente l'annuaire des joueurs avec pseudo/avatar envoyés par le
      // frontend — sans ça, un joueur dont la toute première action sur le
      // site est de réclamer sa clé quotidienne (jamais joué, jamais ouvert
      // le Vault) n'apparaît nulle part dans l'annuaire, et son entrée dans
      // le classement de série se retrouve avec un pseudo/avatar vides.
      const userEntry = await touchUserDirectory(env, discordId, body.pseudo || '', body.avatarUrl || '');
      if (userEntry.banned) {
        return new Response(JSON.stringify({ ok: false, reason: 'banned' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const config = await getKeysConfig(env);
      const balance = await getKeysBalance(env, discordId, config);
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

      if (balance.lastTopUp === today) {
        return new Response(JSON.stringify({ ok: false, reason: 'already_claimed', claim: buildClaimState(balance), keys: roundKeys(balance.keys || 0) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // La série continue si la dernière réclamation date d'hier, sinon elle repart à 1.
      // Les jours manqués sont perdus : on ne crédite qu'une seule journée.
      balance.streak = (balance.lastTopUp === yesterday) ? (balance.streak || 0) + 1 : 1;
      balance.keys = roundKeys((balance.keys || 0) + DAILY_KEYS);
      balance.lastTopUp = today;
      await saveKeysBalance(env, discordId, balance);
      await upsertStreak(env, discordId, userEntry.pseudo || '', userEntry.avatarUrl || '', balance.streak, today);

      return new Response(JSON.stringify({
        ok: true,
        claimed: DAILY_KEYS,
        keys: balance.keys,
        claim: buildClaimState(balance),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/stats/overview' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ days: [], games: {}, totals: {} }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const gameNamesStats = ['mines', 'blackjack', 'dice', 'slots'];

      // 30 derniers jours, du plus ancien au plus récent
      const DAYS = 30;
      const dayKeys = [];
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      for (let i = DAYS - 1; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000);
        dayKeys.push(d.toISOString().slice(0, 10));
      }
      const byDay = {};
      for (const k of dayKeys) byDay[k] = { wagered: 0, payout: 0, plays: 0 };

      // Comptes masqués depuis l'onglet Leaderboard : ils sont aussi retirés des
      // statistiques, sinon les comptes de test faussent tous les totaux.
      const statsAdjustments = await getWagerAdjustments(env);
      const statsExcluded = statsAdjustments.__excluded || {};

      const games = {};
      const players = new Set();
      let totalWagered = 0, totalPayout = 0, totalPlays = 0;

      for (const name of gameNamesStats) {
        const plays = await getGamePlays(env, name);
        let gWager = 0, gPayout = 0;
        let excludedPlays = 0;
        for (const p of plays) {
          if (p.discordId && statsExcluded[p.discordId]) { excludedPlays++; continue; }
          const bet = parseFloat(p.bet) || 0;
          // Mines : une partie perdue ne rapporte rien
          const payout = p.busted ? 0 : (parseFloat(p.payout) || 0);
          gWager += bet;
          gPayout += payout;
          if (p.discordId) players.add(p.discordId);
          const ts = p.dateMs ? new Date(p.dateMs) : null;
          if (ts) {
            const dk = ts.toISOString().slice(0, 10);
            if (byDay[dk]) {
              byDay[dk].wagered += bet;
              byDay[dk].payout += payout;
              byDay[dk].plays += 1;
            }
          }
        }
        games[name] = {
          plays: plays.length - excludedPlays,
          wagered: roundKeys(gWager),
          payout: roundKeys(gPayout),
          margin: roundKeys(gWager - gPayout),
        };
        totalWagered += gWager;
        totalPayout += gPayout;
        totalPlays += (plays.length - excludedPlays);
      }

      const days = dayKeys.map(k => ({
        date: k,
        wagered: roundKeys(byDay[k].wagered),
        payout: roundKeys(byDay[k].payout),
        plays: byDay[k].plays,
      }));

      // Solde total en circulation (somme des clés détenues par les joueurs),
      // hors comptes masqués.
      const dir = await getUserDirectory(env);
      const playerIds = Object.keys(dir).filter(id => !statsExcluded[id]);
      let keysInCirculation = 0;
      for (const id of playerIds) {
        const raw = await env.SUBMISSIONS.get(`mines_balance_${id}`);
        if (raw) {
          try { keysInCirculation += parseFloat(JSON.parse(raw).keys) || 0; } catch (e) {}
        }
      }

      return new Response(JSON.stringify({
        days,
        games,
        totals: {
          wagered: roundKeys(totalWagered),
          payout: roundKeys(totalPayout),
          margin: roundKeys(totalWagered - totalPayout),
          plays: totalPlays,
          uniquePlayers: players.size,
          registeredPlayers: playerIds.length,
          keysInCirculation: roundKeys(keysInCirculation),
        },
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/leaderboard/admin' && request.method === 'GET') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      if (!env.SUBMISSIONS) {
        return new Response(JSON.stringify({ leaderboard: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Source de vérité : le total lifetime (jamais tronqué), pas les logs
      // *_plays qui ne gardent que les 1000 dernières parties par jeu.
      const totals = await getWagerTotals(env);
      const adjustments = await getWagerAdjustments(env);
      const excluded = adjustments.__excluded || {};
      const dir = await getUserDirectory(env);
      for (const discordId of Object.keys(adjustments)) {
        if (discordId === '__excluded') continue;
        if (!totals[discordId]) {
          const entry = dir[discordId] || {};
          totals[discordId] = { wager: 0, plays: 0, pseudo: entry.pseudo || '', avatarUrl: entry.avatarUrl || '' };
        }
      }
      const list = Object.keys(totals).map(discordId => {
        const rawWager = roundKeys(totals[discordId].wager);
        const adjustment = roundKeys(adjustments[discordId] || 0);
        return {
          discordId,
          pseudo: totals[discordId].pseudo,
          avatarUrl: totals[discordId].avatarUrl,
          plays: totals[discordId].plays,
          rawWager,
          adjustment,
          wager: roundKeys(Math.max(0, rawWager + adjustment)),
          excluded: !!excluded[discordId],
        };
      });
      list.sort((a, b) => b.wager - a.wager);
      return new Response(JSON.stringify({ leaderboard: list }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /leaderboard/set-wager -> corrige le total misé affiché d'un joueur (protégé)
    // body: { discordId, mode: 'set'|'add'|'reset', value }
    // ---------------------------------------------------------------
    if (url.pathname === '/leaderboard/set-wager' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const discordId = String(body.discordId || '').trim();
      const mode = String(body.mode || 'set');
      const value = parseFloat(body.value);
      const rawWager = parseFloat(body.rawWager);
      if (!discordId) {
        return new Response('discordId manquant', { status: 400, headers: corsHeaders });
      }
      const adjustments = await getWagerAdjustments(env);
      if (mode === 'reset') {
        delete adjustments[discordId];
      } else if (mode === 'add') {
        if (!Number.isFinite(value)) return new Response('Valeur invalide', { status: 400, headers: corsHeaders });
        adjustments[discordId] = roundKeys((adjustments[discordId] || 0) + value);
      } else {
        // 'set' : on vise un total final précis, donc la correction = cible - total réel
        if (!Number.isFinite(value) || !Number.isFinite(rawWager)) {
          return new Response('Valeur invalide', { status: 400, headers: corsHeaders });
        }
        adjustments[discordId] = roundKeys(value - rawWager);
      }
      await saveWagerAdjustments(env, adjustments);
      return new Response(JSON.stringify({ ok: true, adjustment: adjustments[discordId] || 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // POST /leaderboard/exclude -> masque/réaffiche un joueur du classement public (protégé)
    // ---------------------------------------------------------------
    if (url.pathname === '/leaderboard/exclude' && request.method === 'POST') {
      if (!checkDashboardKey(request, env)) {
        return new Response('Non autorisé', { status: 401, headers: corsHeaders });
      }
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response('JSON invalide', { status: 400, headers: corsHeaders });
      }
      const discordId = String(body.discordId || '').trim();
      const excluded = !!body.excluded;
      if (!discordId) {
        return new Response('discordId manquant', { status: 400, headers: corsHeaders });
      }
      const adjustments = await getWagerAdjustments(env);
      if (!adjustments.__excluded) adjustments.__excluded = {};
      if (excluded) adjustments.__excluded[discordId] = true;
      else delete adjustments.__excluded[discordId];
      await saveWagerAdjustments(env, adjustments);
      return new Response(JSON.stringify({ ok: true, excluded }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---------------------------------------------------------------
    // GET /discord/membership?discordId=... -> l'utilisateur est-il actuellement
    // sur le serveur Discord ? Utilisé par profile.html pour afficher un rappel
    // "rejoins le serveur" si besoin (les DMs de bonus ne partent pas sinon, car
    // un bot ne peut DM que quelqu'un avec qui il partage un serveur).
    // ---------------------------------------------------------------
    if (url.pathname === '/discord/membership' && request.method === 'GET') {
      const discordId = (url.searchParams.get('discordId') || '').trim();
      if (!discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_discord_id' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) {
        // Pas configuré : on ne peut pas vérifier, donc on n'affiche pas de faux
        // avertissement au joueur -> on répond "membre" par défaut.
        return new Response(JSON.stringify({ ok: true, isMember: true, checked: false }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      try {
        const resp = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}`, {
          headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
        if (resp.status === 200) {
          return new Response(JSON.stringify({ ok: true, isMember: true, checked: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (resp.status === 404) {
          return new Response(JSON.stringify({ ok: true, isMember: false, checked: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // Erreur Discord inattendue (rate limit, bot mal configuré...) : on ne
        // veut pas afficher un faux avertissement, donc on répond "membre".
        return new Response(JSON.stringify({ ok: true, isMember: true, checked: false }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: true, isMember: true, checked: false }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ---------------------------------------------------------------
    // POST /discord/join-guild -> ajoute automatiquement l'utilisateur au serveur Discord
    // (nécessite le scope OAuth "guilds.join" côté front + le bot déjà présent sur le
    // serveur avec la permission "Créer une invitation instantanée")
    // ---------------------------------------------------------------
    if (url.pathname === '/discord/join-guild' && request.method === 'POST') {
      if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) {
        return new Response(JSON.stringify({ ok: false, reason: 'not_configured' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, reason: 'bad_request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const accessToken = String(body.accessToken || '').trim();
      const discordId = String(body.discordId || '').trim();
      if (!accessToken || !discordId) {
        return new Response(JSON.stringify({ ok: false, reason: 'missing_fields' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      try {
        const joinResp = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordId}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ access_token: accessToken }),
        });

        // 201 = ajouté à l'instant, 204 = était déjà membre du serveur : les deux sont des succès
        if (joinResp.status === 201 || joinResp.status === 204) {
          return new Response(JSON.stringify({ ok: true, alreadyMember: joinResp.status === 204 }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const errText = await joinResp.text();
        return new Response(JSON.stringify({ ok: false, reason: 'discord_error', status: joinResp.status, detail: errText }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, reason: 'fetch_failed', detail: err.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ---------------------------------------------------------------
    // POST /notify -> reçoit une demande de bonus depuis le site
    // ---------------------------------------------------------------
    if (url.pathname === '/notify' || url.pathname === '/') {
      if (request.method !== 'POST') {
        return new Response('Méthode non autorisée', { status: 405, headers: corsHeaders });
      }
      return handleNotify(request, env, corsHeaders);
    }

    return new Response('Introuvable', { status: 404, headers: corsHeaders });
  },
};

// Envoie un message privé (DM) à un utilisateur Discord via son ID.
// Nécessite le secret DISCORD_BOT_TOKEN et que le bot partage un serveur avec l'utilisateur.
// ===== Sessions signées (HMAC) : l'identité ne vient plus jamais du navigateur =====
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function _b64url(bytes) {
  let bin = ''; const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b;
}
async function _hmacKey(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function createSessionToken(env, discordId, username) {
  const payload = { d: discordId, u: username || '', exp: Date.now() + SESSION_TTL_MS };
  const p = _b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await _hmacKey(env), new TextEncoder().encode(p));
  return p + '.' + _b64url(sig);
}
async function verifySessionToken(env, token) {
  if (!token || !env.SESSION_SECRET) return null;
  const parts = String(token).split('.'); if (parts.length !== 2) return null;
  const [p, sig] = parts;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await _hmacKey(env),
      _b64urlToBytes(sig), new TextEncoder().encode(p));
  } catch (e) { return null; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(_b64urlToBytes(p))); } catch (e) { return null; }
  if (!payload || !payload.d || !payload.exp || Date.now() > payload.exp) return null;
  return { discordId: String(payload.d), username: payload.u || '' };
}
// Renvoie le discordId AUTHENTIFIÉ d'une requête (entête "Authorization: Bearer <token>"), ou null.
async function authedDiscordId(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = await verifySessionToken(env, token);
  return s ? s.discordId : null;
}


async function sendDiscordDM(userId, message, env) {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error('DISCORD_BOT_TOKEN non configuré sur le Worker');
  }

  // 1. Ouvre (ou récupère) le canal de DM avec cet utilisateur
  const dmChannelResp = await fetch('https://discord.com/api/users/@me/channels', {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ recipient_id: userId }),
  });

  if (!dmChannelResp.ok) {
    const errText = await dmChannelResp.text();
    throw new Error(`Impossible d'ouvrir le DM (${dmChannelResp.status}) : ${errText}`);
  }

  const dmChannel = await dmChannelResp.json();

  // 2. Envoie le message dans ce canal
  const sendResp = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: message }),
  });

  if (!sendResp.ok) {
    const errText = await sendResp.text();
    throw new Error(`Échec de l'envoi du DM (${sendResp.status}) : ${errText}`);
  }
}

async function getVaultHistory(env) {
  const raw = await env.SUBMISSIONS.get('vault_history');
  return raw ? JSON.parse(raw) : [];
}

async function addVaultHistoryEntry(env, entry) {
  const history = await getVaultHistory(env);
  history.push(entry);
  const trimmed = history.slice(-100);
  await env.SUBMISSIONS.put('vault_history', JSON.stringify(trimmed));
}

// Lit l'état atomique du round en cours depuis D1 (source de vérité unique, sans risque de course).
async function getVaultRound(env) {
  if (!env.VAULT_DB) return null;
  const row = await env.VAULT_DB.prepare(
    'SELECT code, amount, claimed, claimed_at, claimed_ip, claimed_username FROM vault_round WHERE id = 1'
  ).first();
  return row || null;
}

// Suivi des IP ayant tenté ce round (purement informatif pour le compteur "participants",
// n'a aucun impact sur la sécurité/l'atomicité du gain — celle-ci vit entièrement dans D1).
async function getVaultParticipants(env) {
  if (!env.SUBMISSIONS) return [];
  const raw = await env.SUBMISSIONS.get('vault_participants');
  return raw ? JSON.parse(raw) : [];
}

async function addVaultParticipant(env, ip) {
  const list = await getVaultParticipants(env);
  if (!list.includes(ip)) {
    list.push(ip);
    await env.SUBMISSIONS.put('vault_participants', JSON.stringify(list));
  }
  return list;
}

async function resetVaultParticipants(env) {
  if (!env.SUBMISSIONS) return;
  await env.SUBMISSIONS.put('vault_participants', JSON.stringify([]));
}

function checkDashboardKey(request, env) {
  if (!env.DASHBOARD_KEY) return false;
  const key = request.headers.get('X-Dashboard-Key');
  return key === env.DASHBOARD_KEY;
}

// Normalise un nom de casino en identifiant stable pour le stockage/matching
// (ex: "Duel.com" -> "duelcom", "Rollbit.com" -> "rollbitcom").
function slugifyCasino(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ===================================================================
// STOCKAGE DES DEMANDES DE BONUS — migré de KV (un seul blob JSON réécrit en
// entier à chaque action) vers D1 (une ligne par demande, écritures atomiques).
// -------------------------------------------------------------------
// PROBLÈME RÉSOLU : avec l'ancien stockage KV, chaque nouvelle demande (et
// chaque archivage/refus/tip/suppression) relisait TOUT le tableau, le
// modifiait en mémoire, puis réécrivait TOUT le tableau. KV n'offre aucune
// garantie d'atomicité sur ce genre de "lire-modifier-écrire" : si deux
// requêtes arrivent presque en même temps (deux joueurs qui soumettent une
// demande au même moment, ou un admin qui archive pendant qu'une nouvelle
// demande arrive), la deuxième écriture peut silencieusement écraser la
// première. Résultat concret observé : un joueur reçoit bien la confirmation
// Telegram (donc sa demande a bien été traitée à un instant T), mais elle
// n'apparaît plus dans le dashboard — une autre écriture concurrente a
// écrasé la sienne juste après.
// Avec D1, chaque demande est sa propre ligne : un INSERT/UPDATE/DELETE ne
// touche QUE cette ligne, sans jamais pouvoir écraser les autres, même en
// cas d'écritures simultanées.
// ===================================================================

async function ensureSubmissionsTable(env) {
  await env.VAULT_DB.prepare(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      date TEXT,
      dateMs INTEGER,
      platform TEXT,
      code TEXT,
      pseudo TEXT,
      email TEXT,
      discordId TEXT,
      deviceId TEXT,
      ip TEXT,
      country TEXT,
      tipped INTEGER,
      archived INTEGER,
      status TEXT,
      statusAt INTEGER,
      declineReason TEXT,
      declineNote TEXT
    )
  `).run();
}

function rowToSubmission(row) {
  return {
    id: row.id,
    date: row.date,
    dateMs: row.dateMs,
    platform: row.platform,
    code: row.code,
    pseudo: row.pseudo,
    email: row.email,
    discordId: row.discordId || '',
    deviceId: row.deviceId || '',
    ip: row.ip,
    country: row.country,
    tipped: !!row.tipped,
    archived: !!row.archived,
    status: row.status,
    statusAt: row.statusAt,
    declineReason: row.declineReason || '',
    declineNote: row.declineNote || '',
  };
}

// Lecture : source de vérité = D1 dès qu'elle contient des données. Tant que
// la migration one-shot (/admin/migrate-submissions-to-d1) n'a pas été
// lancée, on retombe sur l'ancien blob KV pour ne rien casser entre-temps.
async function getAllSubmissions(env) {
  if (env.VAULT_DB) {
    try {
      await ensureSubmissionsTable(env);
      const { results } = await env.VAULT_DB.prepare('SELECT * FROM submissions ORDER BY dateMs ASC').all();
      if (results && results.length > 0) {
        return results.map(rowToSubmission);
      }
    } catch (e) {
      console.warn('Lecture D1 des demandes échouée, repli sur KV :', e.message);
    }
  }
  if (!env.SUBMISSIONS) return [];
  const raw = await env.SUBMISSIONS.get('all_submissions');
  return raw ? JSON.parse(raw) : [];
}

// Ancienne fonction, conservée pour compatibilité mais plus utilisée par les
// écritures (voir insertSubmission/updateSubmission/deleteSubmissionById
// ci-dessous, qui touchent une seule ligne au lieu de tout réécrire).
async function saveAllSubmissions(env, all) {
  const trimmed = all.slice(-2000);
  await env.SUBMISSIONS.put('all_submissions', JSON.stringify(trimmed));
}

async function getSubmissionById(env, id) {
  await ensureSubmissionsTable(env);
  const row = await env.VAULT_DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
  return row ? rowToSubmission(row) : null;
}

async function insertSubmission(env, entry) {
  await ensureSubmissionsTable(env);
  await env.VAULT_DB.prepare(`
    INSERT INTO submissions (id, date, dateMs, platform, code, pseudo, email, discordId, deviceId, ip, country, tipped, archived, status, statusAt, declineReason, declineNote)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.id, entry.date, entry.dateMs, entry.platform, entry.code || '', entry.pseudo, entry.email,
    entry.discordId || '', entry.deviceId || '', entry.ip, entry.country,
    entry.tipped ? 1 : 0, entry.archived ? 1 : 0, entry.status, entry.statusAt,
    entry.declineReason || '', entry.declineNote || ''
  ).run();
}

async function updateSubmission(env, id, fields) {
  await ensureSubmissionsTable(env);
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const setClause = cols.map(c => `${c} = ?`).join(', ');
  const values = cols.map(c => {
    const v = fields[c];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
  values.push(id);
  await env.VAULT_DB.prepare(`UPDATE submissions SET ${setClause} WHERE id = ?`).bind(...values).run();
}

async function deleteSubmissionById(env, id) {
  await ensureSubmissionsTable(env);
  const result = await env.VAULT_DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
  return (result.meta && result.meta.changes > 0);
}

// ---- Limites de soumission par offre (configurables depuis /admin) ----
// Stockées à part de la config statique du site : modifiables sans republier
// nitrodrop-config.js sur GitHub, avec effet immédiat.
async function getBonusLimits(env) {
  const raw = await env.SUBMISSIONS.get('bonus_submission_limits');
  return raw ? JSON.parse(raw) : {};
}

async function handleNotify(request, env, corsHeaders) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return new Response('Relais non configuré : secrets manquants', { status: 500, headers: corsHeaders });
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return new Response('JSON invalide', { status: 400, headers: corsHeaders });
  }

  const { platform, code, email, pseudo, discordId, deviceId } = data;

  if (!platform || !email || !pseudo) {
    return new Response('Champs manquants', { status: 400, headers: corsHeaders });
  }
  if (String(email).length > 200 || String(pseudo).length > 200) {
    return new Response('Champs trop longs', { status: 400, headers: corsHeaders });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'inconnue';
  const country = request.cf && request.cf.country ? request.cf.country : 'inconnu';
  const userAgent = request.headers.get('User-Agent') || 'inconnu';
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // ---- Blocage réel : même casino + même pseudo OU même Discord ID dans les dernières 24h ----
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  if (env.SUBMISSIONS) {
    const allExisting = await getAllSubmissions(env);
    const recentDuplicate = allExisting.find(entry =>
      entry.platform === platform &&
      typeof entry.dateMs === 'number' &&
      (nowMs - entry.dateMs) < TWENTY_FOUR_HOURS_MS &&
      (
        (entry.pseudo && String(entry.pseudo).toLowerCase() === String(pseudo).toLowerCase()) ||
        (discordId && entry.discordId && entry.discordId === discordId)
      )
    );
    if (recentDuplicate) {
      const hoursRemaining = Math.max(1, Math.ceil((TWENTY_FOUR_HOURS_MS - (nowMs - recentDuplicate.dateMs)) / (60 * 60 * 1000)));
      return new Response(JSON.stringify({ ok: false, reason: 'duplicate_24h', hoursRemaining }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ---- Limite de soumissions par casino, configurée depuis /admin ----
    // Compte TOUTES les demandes passées (acceptées, refusées, en attente)
    // pour ce joueur sur ce casino précis — pas seulement les 24 dernières
    // heures. C'est le vrai verrou ; le front-end grise déjà le bouton avant,
    // mais ceci reste valable même en cas d'appel direct à l'API.
    const limits = await getBonusLimits(env);
    const maxForPlatform = limits[platform] || 0;
    if (maxForPlatform > 0 && discordId) {
      const countForPlatform = allExisting.filter(entry =>
        entry.platform === platform && entry.discordId === discordId
      ).length;
      if (countForPlatform >= maxForPlatform) {
        return new Response(JSON.stringify({ ok: false, reason: 'limit_reached', limit: maxForPlatform }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
  }

  // ---- Détection de doublons par IP + enregistrement global (nécessite le binding KV "SUBMISSIONS") ----
  let duplicateWarning = '';
  if (env.SUBMISSIONS) {
    const key = `ip:${ip}`;
    const existingRaw = await env.SUBMISSIONS.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];

    if (existing.length > 0) {
      duplicateWarning =
        `\n\n⚠️ ATTENTION : cette IP a déjà soumis ${existing.length} demande(s) avant celle-ci :\n` +
        existing.map(e => `- ${e.pseudo} / ${e.email} / ${e.platform} (${e.date})`).join('\n');
    }

    existing.push({ pseudo, email, platform, date: now });
    await env.SUBMISSIONS.put(key, JSON.stringify(existing), { expirationTtl: 60 * 60 * 24 * 30 });

    // Enregistrement dans la liste globale consultable depuis le dashboard.
    // C'est ICI précisément que se produisait la perte silencieuse de
    // demandes : deux joueurs soumettant en même temps pouvaient s'écraser
    // mutuellement avec l'ancien stockage KV (lire tout -> ajouter -> tout
    // réécrire). insertSubmission() fait un INSERT D1 sur une ligne dédiée à
    // CETTE demande : aucune autre écriture concurrente ne peut l'affecter.
    const newEntry = {
      id: crypto.randomUUID(),
      date: now,
      dateMs: nowMs,
      platform,
      code,
      pseudo,
      email,
      discordId: discordId || '',
      deviceId: deviceId || '',
      ip,
      country,
      tipped: false,
      archived: false,
      // Suivi de la demande, visible par le joueur sur sa page Profil.
      // 'pending' -> en attente | 'sent' -> bonus envoyé | 'declined' -> refusé
      status: 'pending',
      statusAt: nowMs,
      declineReason: '',
      declineNote: '',
    };
    if (env.VAULT_DB) {
      await insertSubmission(env, newEntry);
    } else {
      // Repli si D1 indisponible (comportement historique, sujet à la race condition connue)
      const all = await getAllSubmissions(env);
      all.push(newEntry);
      await saveAllSubmissions(env, all);
    }
  }

  const text =
    `🎰 Casino : ${platform}${code ? ' - Code : ' + code : ''}\n` +
    `👤 Username : ${pseudo}\n` +
    `📧 Email : ${email}\n` +
    `💬 Discord ID : ${discordId || 'non fourni'}\n\n` +
    `🕵️ Infos anti-fraude\n` +
    `🌍 IP : ${ip} (${country})\n` +
    `💻 Navigateur : ${userAgent}` +
    duplicateWarning;

  const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const tgResponse = await fetch(tgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });

  if (!tgResponse.ok) {
    return new Response('Échec de l\'envoi Telegram', { status: 502, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}