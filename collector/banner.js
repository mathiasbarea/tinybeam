// Tinybeam's optional consent banner (docs/spec.md, section 5), served by the collector at
// `${path}/banner.js?s=<site>&l=<page language>,<browser language>` with the site's texts in one language.
// The core loads it only for visitors who must be asked, or when a "privacy settings" element is clicked.
// The generated code sticks to ES5 syntax, like the core's target browsers.

export const BANNER_TEXTS = {
  en: {
    title: 'Your privacy',
    body: 'We count visits anonymously and in aggregate to improve this site. With your permission, we will also use a cookie to recognize you when you come back, and share visit data with advertising platforms to measure our ads.',
    accept: 'Accept', reject: 'Reject', customize: 'Choose', save: 'Save choices',
    analytics: 'Recognize me when I come back (cookie)', ads: 'Share visit data with advertising platforms', privacy: 'Privacy policy',
  },
  es: {
    title: 'Tu privacidad',
    body: 'Contamos las visitas de forma anónima y agregada para mejorar este sitio. Con tu permiso, también usaremos una cookie para reconocerte cuando vuelvas y compartiremos datos de la visita con plataformas de publicidad para medir nuestros anuncios.',
    accept: 'Aceptar', reject: 'Rechazar', customize: 'Elegir', save: 'Guardar',
    analytics: 'Reconocerme cuando vuelva (cookie)', ads: 'Compartir datos de la visita con plataformas de publicidad', privacy: 'Política de privacidad',
  },
  pt: {
    title: 'Sua privacidade',
    body: 'Contamos as visitas de forma anônima e agregada para melhorar este site. Com sua permissão, também usaremos um cookie para reconhecer você quando voltar e compartilharemos dados da visita com plataformas de publicidade para medir nossos anúncios.',
    accept: 'Aceitar', reject: 'Recusar', customize: 'Escolher', save: 'Salvar escolhas',
    analytics: 'Reconhecer-me quando eu voltar (cookie)', ads: 'Compartilhar dados da visita com plataformas de publicidade', privacy: 'Política de privacidade',
  },
  fr: {
    title: 'Votre vie privée',
    body: 'Nous comptons les visites de façon anonyme et agrégée pour améliorer ce site. Avec votre accord, nous utiliserons aussi un cookie pour vous reconnaître lors de votre retour et partagerons les données de visite avec des plateformes publicitaires pour mesurer nos annonces.',
    accept: 'Accepter', reject: 'Refuser', customize: 'Choisir', save: 'Enregistrer mes choix',
    analytics: 'Me reconnaître à mon retour (cookie)', ads: 'Partager les données de visite avec des plateformes publicitaires', privacy: 'Politique de confidentialité',
  },
  de: {
    title: 'Ihre Privatsphäre',
    body: 'Wir zählen Besuche anonym und zusammengefasst, um diese Website zu verbessern. Mit Ihrer Zustimmung verwenden wir außerdem ein Cookie, um Sie bei Ihrem nächsten Besuch wiederzuerkennen, und teilen Besuchsdaten mit Werbeplattformen, um unsere Anzeigen zu messen.',
    accept: 'Akzeptieren', reject: 'Ablehnen', customize: 'Auswählen', save: 'Auswahl speichern',
    analytics: 'Mich beim nächsten Besuch wiedererkennen (Cookie)', ads: 'Besuchsdaten mit Werbeplattformen teilen', privacy: 'Datenschutzerklärung',
  },
  it: {
    title: 'La tua privacy',
    body: 'Contiamo le visite in forma anonima e aggregata per migliorare questo sito. Con il tuo consenso useremo anche un cookie per riconoscerti quando torni e condivideremo i dati della visita con piattaforme pubblicitarie per misurare i nostri annunci.',
    accept: 'Accetta', reject: 'Rifiuta', customize: 'Scegli', save: 'Salva le scelte',
    analytics: 'Riconoscimi quando torno (cookie)', ads: 'Condividi i dati della visita con piattaforme pubblicitarie', privacy: 'Informativa sulla privacy',
  },
  nl: {
    title: 'Je privacy',
    body: 'We tellen bezoeken anoniem en geaggregeerd om deze site te verbeteren. Met je toestemming gebruiken we ook een cookie om je te herkennen als je terugkomt, en delen we bezoekgegevens met advertentieplatforms om onze advertenties te meten.',
    accept: 'Accepteren', reject: 'Weigeren', customize: 'Kiezen', save: 'Keuzes opslaan',
    analytics: 'Herken me als ik terugkom (cookie)', ads: 'Bezoekgegevens delen met advertentieplatforms', privacy: 'Privacybeleid',
  },
  pl: {
    title: 'Twoja prywatność',
    body: 'Liczymy odwiedziny anonimowo i zbiorczo, aby ulepszać tę stronę. Za Twoją zgodą użyjemy też pliku cookie, aby rozpoznać Cię przy kolejnej wizycie, i udostępnimy dane o wizycie platformom reklamowym, aby mierzyć skuteczność naszych reklam.',
    accept: 'Akceptuję', reject: 'Odrzucam', customize: 'Wybierz', save: 'Zapisz wybór',
    analytics: 'Rozpoznaj mnie przy kolejnej wizycie (cookie)', ads: 'Udostępniaj dane o wizycie platformom reklamowym', privacy: 'Polityka prywatności',
  },
};
export const TEXT_KEYS = Object.keys(BANNER_TEXTS.en);

// The languages a site has texts for: the built-in ones plus those the owner added.
export const bannerLanguages = settings => [...new Set([...Object.keys(BANNER_TEXTS), ...Object.keys(settings.texts || {})])];

// The language to show: the site's fixed one, or the first of the requested ones (page, then browser)
// that the site has texts for, by exact tag or base language; otherwise the site's default.
export function pickLanguage(settings, requested) {
  const available = bannerLanguages(settings);
  if (settings.bannerLanguage && settings.bannerLanguage !== 'auto' && available.includes(settings.bannerLanguage)) return settings.bannerLanguage;
  for (const tag of String(requested || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)) {
    if (available.includes(tag)) return tag;
    const base = tag.split('-')[0];
    if (available.includes(base)) return base;
  }
  return available.includes(settings.defaultLanguage) ? settings.defaultLanguage : 'en';
}

// The texts for one language: the owner's, over the built-in translation, over English.
export function bannerTexts(settings, language) {
  const builtIn = BANNER_TEXTS[language] || BANNER_TEXTS[language.split('-')[0]] || {};
  return { ...BANNER_TEXTS.en, ...builtIn, ...((settings.texts || {})[language] || {}) };
}

// JSON safe to embed in a script: no `<` (so no closing tag) and no line separators.
const json = value => JSON.stringify(value).replace(/[<\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export function renderBanner(settings, requested) {
  const language = pickLanguage(settings, requested);
  const texts = bannerTexts(settings, language);
  const privacy = (settings.privacy || {})[language] || (settings.privacy || {})[settings.defaultLanguage] || '';
  const options = {
    lang: language,
    privacy: /^https?:\/\//.test(privacy) ? privacy : '',
    position: ['bottom', 'bottom-left', 'bottom-right'].includes(settings.position) ? settings.position : 'bottom',
    color: /^#[0-9a-fA-F]{3,8}$/.test(settings.color || '') ? settings.color : '#2457d6',
  };
  return `(function(t,o){var tb=window.tinybeam,d=document;if(!tb||!d.body)return;
var old=d.getElementById("tb-consent");if(old)old.parentNode.removeChild(old);
function el(tag,css,text){var e=d.createElement(tag);if(css)e.style.cssText=css;if(text)e.textContent=text;return e}
var side=o.position==="bottom-left"?"left:16px;":o.position==="bottom-right"?"right:16px;":"left:16px;right:16px;margin:0 auto;";
var box=el("div","position:fixed;bottom:16px;"+side+"max-width:520px;z-index:2147483647;background:#fff;color:#111;border:1px solid #ddd;border-radius:10px;padding:16px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.15)");
box.id="tb-consent";box.setAttribute("role","dialog");box.setAttribute("aria-label",t.title);box.setAttribute("lang",o.lang);
box.appendChild(el("strong","display:block;margin-bottom:4px",t.title));
var p=el("p","margin:0 0 12px",t.body+" ");
if(o.privacy){var a=el("a","color:"+o.color,t.privacy);a.href=o.privacy;p.appendChild(a)}
box.appendChild(p);
var checks=el("div","display:none;margin:0 0 12px"),inputs={};
["analytics","ads"].forEach(function(k){var l=el("label","display:block;margin:4px 0"),i=el("input","margin-right:6px");i.type="checkbox";inputs[k]=i;l.appendChild(i);l.appendChild(d.createTextNode(t[k]));checks.appendChild(l)});
box.appendChild(checks);
var row=el("div","display:flex;gap:8px;flex-wrap:wrap");
function button(text,fn){var b=el("button","flex:1 1 auto;padding:8px 12px;border-radius:6px;font:inherit;cursor:pointer;border:1px solid "+o.color+";background:"+o.color+";color:#fff",text);b.type="button";b.onclick=fn;row.appendChild(b);return b}
function choose(a,ads){tb.consent({analytics:a,ads:ads,source:"banner"});if(box.parentNode)box.parentNode.removeChild(box)}
button(t.reject,function(){choose(false,false)});
var custom=button(t.customize,function(){if(checks.style.display==="none"){checks.style.display="block";custom.textContent=t.save}else choose(inputs.analytics.checked,inputs.ads.checked)});
custom.style.background="transparent";custom.style.color=o.color;
button(t.accept,function(){choose(true,true)});
box.appendChild(row);d.body.appendChild(box)})(${json(texts)},${json(options)});`;
}
