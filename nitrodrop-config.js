// ===================================================================
// NITRODROP — Configuration du site
// Ce fichier est mis à jour automatiquement par admin.html (bouton "Publier sur GitHub").
// Tu peux aussi le modifier à la main si besoin.
// ===================================================================

const NITRODROP_STORAGE_KEY = 'nitrodrop_config_v1';

const NITRODROP_DEFAULT_CONFIG = {
  "nav": {
    "links": [
      {
        "label": "Codes bonus",
        "href": "#offres "
      },
      {
        "label": "Classement",
        "href": "#classement"
      },
      {
        "label": "Comment ça marche",
        "href": "#etapes"
      },
      {
        "label": "Discord",
        "href": "#"
      }
    ],
    "ctaText": "Voir les codes",
    "ctaHref": "#offres"
  },
  "hero": {
    "eyebrow": "Codes vérifiés · Mis à jour aujourd'hui",
    "titleLine1": "Ton dépôt mérite",
    "titleEm": "un vrai bonus.",
    "lede": "NITRODROP tipe directement les joueurs qui s'inscrivent avec son code. Pas de dépôt requis : renseigne ton pseudo, et ton bonus est envoyé sous 24h.",
    "code": "NITRO200",
    "btnPrimaryText": "Voir les offres",
    "btnPrimaryHref": "#offres",
    "btnGhostText": "Comment l'utiliser",
    "btnGhostHref": "#etapes"
  },
  "telegram": {
    "tag": "Tuto NitroDrop FR",
    "title": "Un guide pas à pas t'attend sur Telegram",
    "desc": "Création du compte, saisie du code NITRO200, dépôt et suivi du classement : tout est expliqué en français, étape par étape.",
    "btnText": "Ouvrir le tuto Telegram →",
    "btnHref": "#"
  },
  "offersSection": {
    "tag": "Exclusive Offers",
    "title": "No Deposit Bonuses",
    "desc": "Sign up, verify your account, and click \"Claim My Bonus\" to unlock your no deposit bonus."
  },
  "offers": [
    {
      "featured": true,
      "badge": "TOP",
      "mark": "V",
      "markClass": "mark-1",
      "name": "Duel.com",
      "sub": "Crypto Casino · Instant Withdrawals",
      "bonusAmount": "$9.00",
      "bonusSuffix": "$1.50/day × 6",
      "desc": "Register with the code, submit your username, and get your tip. No deposit needed.",
      "code": "welcomebonus2026",
      "signupHref": "https://duel.com/r/welcomebonus2026",
      "signupText": "Create Account",
      "claimText": "Claim My Bonus"
    },
    {
      "featured": false,
      "badge": "",
      "mark": "R",
      "markClass": "mark-2",
      "name": "Stake.com",
      "sub": "Crypto Casino · Instant Payouts",
      "bonusAmount": "$7.00",
      "bonusSuffix": "$1.00/day × 7",
      "desc": "Register with the code, submit your username, and get your tip. No deposit needed.",
      "code": "NKSCAS",
      "signupHref": "https://stake.bet/?c=3eccdsPf",
      "signupText": "Create Account",
      "claimText": "Claim My Bonus"
    },
    {
      "featured": false,
      "badge": "",
      "mark": "B",
      "markClass": "mark-3",
      "name": "Blazepit",
      "sub": "Nouvelle plateforme · cashback quotidien",
      "bonusAmount": "10€",
      "bonusSuffix": "sans dépôt",
      "desc": "Tip envoyé sous 24h après vérification de ton inscription, sans dépôt requis.",
      "code": "NITROBLAZE",
      "signupHref": "https://blazepit.example/signup?ref=NITROBLAZE",
      "signupText": "S'inscrire",
      "claimText": "Recevoir le bonus"
    }
  ],
  "tickerSettings": {
    "verbText": "vient de réclamer"
  },
  "ticker": [
    {
      "name": "kaelynn_",
      "message": "+180€ sur Voltra"
    },
    {
      "name": "dr0p_ghost",
      "message": "+95€ sur Runeblock"
    },
    {
      "name": "valen.tt",
      "message": "+220€ sur Voltra"
    },
    {
      "name": "ryu_odds",
      "message": "+40€ de cashback sur Blazepit"
    },
    {
      "name": "noa.reef",
      "message": "+310€ sur Voltra"
    },
    {
      "name": "mika_x",
      "message": "+120€ sur Runeblock"
    }
  ],
  "leaderboard": {
    "tag": "Classement mensuel",
    "title": "1 800€ partagés entre les 3 meilleurs parieurs.",
    "desc": "Utilise un code NITRODROP, cumule du volume de mise sur les plateformes partenaires, et grimpe dans le classement. Reset chaque 1er du mois.",
    "poolFigure": "1 800€",
    "poolCaption": "Cagnotte de juillet · se termine dans 15 jours"
  },
  "steps": {
    "tag": "Trois étapes",
    "title": "Comment réclamer un code.",
    "items": [
      {
        "title": "Choisis une plateforme",
        "desc": "Compare les bonus ci-dessus et clique sur \"J'en profite\" pour ouvrir l'inscription."
      },
      {
        "title": "Colle le code",
        "desc": "Renseigne le code correspondant dans le champ prévu au moment du dépôt."
      },
      {
        "title": "Récupère ton bonus",
        "desc": "Le montant est crédité automatiquement. Tu peux ensuite suivre ta position au classement."
      }
    ]
  },
  "footer": {
    "navTitle": "Navigation",
    "navLinks": [
      {
        "label": "Codes bonus",
        "href": "#offres"
      },
      {
        "label": "Classement",
        "href": "#classement"
      },
      {
        "label": "Comment ça marche",
        "href": "#etapes"
      }
    ],
    "communityTitle": "Communauté",
    "communityLinks": [
      {
        "label": "Discord",
        "href": "#"
      },
      {
        "label": "Telegram",
        "href": "#"
      },
      {
        "label": "Contact",
        "href": "#"
      }
    ],
    "disclaimer": "Le jeu comporte des risques : endettement, isolement, dépendance. NITRODROP est un site indépendant à but informatif, il n'exploite aucune plateforme de jeu et ne garantit pas les offres listées, qui restent soumises aux conditions générales de chaque opérateur. Joue avec modération. Aide et information : joueurs-info-service.fr."
  },
  "modal": {
    "gateSubTemplate": "Es-tu déjà inscrit sur {platform} avec le code {code} ?",
    "gateYesText": "Oui, je suis inscrit",
    "gateNoText": "Non, je m'inscris d'abord",
    "formTag": "Réclamer le bonus",
    "formSubTemplate": "Indique l'email et le pseudo de ton compte sur la plateforme. Le tip lié au code {code} est envoyé manuellement sous 24h après vérification de ton inscription — aucun dépôt requis.",
    "emailLabel": "Email",
    "pseudoLabel": "Pseudo sur la plateforme",
    "submitText": "Confirmer ma demande",
    "confirmTitle": "Demande envoyée",
    "confirmTextTemplate": "Ton bonus sera envoyé sous moins de 24h après vérification de ton inscription sur {platform}.",
    "confirmNote": "Un email de confirmation t'a été envoyé. Tu peux fermer cette fenêtre."
  },
  "telegramRelay": {
    "url": "https://nitrodrop-relay.lescagoules05.workers.dev/notify"
  }
};

// ---------- Fonctions de stockage (partagées site + admin) ----------

function nitrodropDeepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function nitrodropLoadConfig() {
  try {
    const raw = localStorage.getItem(NITRODROP_STORAGE_KEY);
    if (!raw) return nitrodropDeepClone(NITRODROP_DEFAULT_CONFIG);
    const saved = JSON.parse(raw);
    const merged = nitrodropDeepClone(NITRODROP_DEFAULT_CONFIG);
    for (const key of Object.keys(merged)) {
      if (saved[key] !== undefined) merged[key] = saved[key];
    }
    return merged;
  } catch (e) {
    console.error('Config NitroDrop illisible, retour aux valeurs par défaut.', e);
    return nitrodropDeepClone(NITRODROP_DEFAULT_CONFIG);
  }
}

function nitrodropSaveConfig(cfg) {
  localStorage.setItem(NITRODROP_STORAGE_KEY, JSON.stringify(cfg));
}

function nitrodropResetConfig() {
  localStorage.removeItem(NITRODROP_STORAGE_KEY);
}
