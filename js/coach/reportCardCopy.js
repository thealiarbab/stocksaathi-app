// =============================================================================
// REPORT CARD COPY — every sentence the report card shows, in English and
// Hinglish (settings.hinglish). Pure, no imports: reportCardCore.js returns
// facts as { key, ...numbers } and this file words them, so the Node tests and
// the real-data validation print exactly what a user would read.
//
// Reflection only, like biasCopy.js: it says what happened in the user's own
// numbers. It never says what to buy or sell.
// =============================================================================

const rupees = (paise) => "₹" + (Math.abs(Number(paise) || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const s = (n, one = "", many = "s") => (Number(n) === 1 ? one : many);
const dateText = (ms) => new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

export const PILLARS = {
  discipline: {
    en: { name: "Discipline", what: "How you decide, not how the market moved. Saathi checks each trade for six habits: selling in a panic after a fall, chasing a stock that has already jumped, going in and out of the same stock within days, placing 10 or more trades in a day, buying more of a falling stock just to lower your average, and selling winners while holding on to losers.",
      how: "Each note is weighted by how serious the habit is and how strong the signal was. A note counts half as much after 45 days. The total is divided by how much you trade, so 2 notes in 300 trades count far less than 2 notes in 5. Until your record is 4 weeks old the score stays near the middle: a few days prove little either way.",
      tryThis: "Before your next sell, write one line on why. If the only reason is today's price, wait for tomorrow's close and read the line again." },
    hi: { name: "Discipline", what: "Tum decide kaise karte ho, market kaise chala woh nahi. Saathi har trade me chhe aadatein dekhta hai: girne ke baad ghabra ke bechna, already uchhal chuke stock ke peeche bhaagna, ek hi stock me kuch dino me baar baar andar bahar, ek din me 10 ya zyada trade, girte stock me sirf average kam karne ke liye aur kharidna, aur winners bech ke losers pakde rehna.",
      how: "Har note ka wazan is par hai ki aadat kitni serious hai aur signal kitna strong tha. 45 din baad note aadha gina jaata hai. Total ko tumhare trades se divide kiya jaata hai, isliye 300 trades me 2 note, 5 trades me 2 note se bahut kam ginte hain. Jab tak record 4 hafte purana nahi hota, score beech ke paas rehta hai: kuch din se kuch saabit nahi hota.",
      tryThis: "Agli baar bechne se pehle ek line likho ki kyun. Agar wajah sirf aaj ka price hai, kal ke close tak ruko aur line dobara padho." },
  },
  results: {
    en: { name: "Results", what: "What your money actually did: your profit or loss, booked and on paper, as a share of the most you ever had invested at once. Cash you kept aside does not water it down. Big falls along the way count too.",
      how: "Breaking even is 50 out of 100. About +5% on the money you invested is 78, +10% is 92; -5% is 22. The curve flattens at both ends, so one huge win cannot carry the whole grade. If your account ever fell more than 10% of your invested money from an earlier high, half of the extra fall comes off. Until your record is 4 weeks old the score stays near 50: one lucky week is not a result yet.",
      tryThis: "Look at your best and worst trade side by side. Was the difference the plan, or the luck?" },
    hi: { name: "Results", what: "Tumhare paise ne asal me kya kiya: profit ya loss, booked aur paper par, us sabse zyada paise ke hisaab se jo kabhi ek saath laga tha. Alag rakha cash isko kam nahi karta. Beech ki badi girawat bhi gini jaati hai.",
      how: "Barabar rehna 100 me 50 hai. Lagaye paise par lagbhag +5% matlab 78, +10% matlab 92; -5% matlab 22. Dono kinaron par curve flat hota hai, isliye ek bahut badi jeet poora grade nahi utha sakti. Agar account kabhi pichhle high se lagaye paise ke 10% se zyada gira, to extra girawat ka aadha kat jaata hai. Record 4 hafte purana hone tak score 50 ke paas rehta hai: ek lucky hafta abhi result nahi hai.",
      tryThis: "Apna sabse achha aur sabse bura trade saath me dekho. Farak plan ka tha ya luck ka?" },
  },
  research: {
    en: { name: "Research", what: "Whether you looked into a stock before putting money in. For every new buy, Saathi checks what you did in the two weeks before: opened the stock's page on an earlier day, used its chart, had it on your watchlist, or asked Saathi about it.",
      how: "One of those is half marks for that buy, two or more is full marks. A buy with none of them, minutes after you first opened the stock, counts as an impulse buy. Topping up a stock you were already trading is not counted: only fresh decisions are. Recent buys count more than old ones.",
      tryThis: "Before your next new stock, add it to your watchlist and come back the next day. If you still want it, check its 1-year chart first." },
    hi: { name: "Research", what: "Paisa lagane se pehle tumne stock ko dekha ya nahi. Har naye buy ke liye Saathi dekhta hai ki pichhle do hafton me tumne kya kiya: stock ka page kisi pehle din khola, uska chart dekha, watchlist me rakha, ya Saathi se uske baare me pucha.",
      how: "Inme se ek ho to us buy ke aadhe marks, do ya zyada ho to poore. Jisme koi nahi, aur stock pehli baar kholne ke kuch minute baad buy kiya, woh impulse buy gina jaata hai. Jis stock me already trade kar rahe the usme aur daalna nahi gina jaata: sirf naye faisle. Naye buys purane se zyada ginte hain.",
      tryThis: "Agle naye stock se pehle use watchlist me daalo aur agle din wapas aao. Phir bhi chahiye ho to pehle uska 1 saal ka chart dekho." },
  },
  diversification: {
    en: { name: "Diversification", what: "How spread out your money is right now: your biggest single stock, your biggest sector, how many real positions you hold, and cash that has sat idle.",
      how: "Biggest stock: full marks under 15% of all your money, none at 60%. Biggest sector (when you hold 2 or more stocks): full marks under 40% of your stock money, none at 90%. Positions: full marks at about 6 evenly sized ones. A mutual fund or ETF is already a basket, so it counts as 5. Cash is not judged in your first month, and only gently after that.",
      tryThis: "Open your portfolio and look at the biggest slice. Ask what happens to the whole if that one company has a bad year." },
    hi: { name: "Diversification", what: "Abhi tumhara paisa kitna phaila hua hai: sabse bada ek stock, sabse bada sector, kitni asli positions hain, aur kitna cash khaali pada hai.",
      how: "Sabse bada stock: poore paise ke 15% se kam par full marks, 60% par zero. Sabse bada sector (jab 2 ya zyada stock ho): stock ke paise ke 40% se kam par full marks, 90% par zero. Positions: lagbhag 6 barabar size ki positions par full marks. Mutual fund ya ETF khud ek basket hai, isliye 5 gina jaata hai. Pehle mahine cash judge nahi hota, uske baad bhi halka sa.",
      tryThis: "Portfolio kholo aur sabse bada hissa dekho. Socho: agar us ek company ka saal kharab gaya to poore portfolio ka kya hoga?" },
  },
  learning: {
    en: { name: "Learning and activity", what: "Steady effort over the last 8 weeks: the weeks you opened the app, crash replays you finished, questions you asked Saathi, and explainers you read. The number of trades never counts here.",
      how: "40 points for showing up each week, 25 for weeks with some learning in them, 20 for how much (a replay, or three questions or explainers, makes a full week), 15 for trying all three kinds. Only so much counts per week, so one busy day does not replace a steady habit. A new account is judged on the weeks it has existed.",
      tryThis: "Pick one this week: finish a crash replay, ask Saathi why a stock you hold moved, or tap a term you do not know." },
    hi: { name: "Seekhna aur activity", what: "Pichhle 8 hafton ki lagataar mehnat: kitne hafte app khola, kitne crash replay poore kiye, Saathi se kitne sawaal puche, aur kitne explainer padhe. Trades ki ginti yahan kabhi nahi ginti.",
      how: "Har hafte aane ke 40 point, jin hafton me kuch seekha unke 25, kitna seekha uske 20 (ek replay, ya teen sawaal ya explainer se hafta poora), aur teeno cheezein try karne ke 15. Ek hafte me ek limit tak hi gina jaata hai, isliye ek busy din lagataar aadat ki jagah nahi leta. Naya account utne hi hafton par judge hota hai jitne se woh bana hai.",
      tryThis: "Is hafte ek chuno: ek crash replay poora karo, Saathi se pucho ki tumhara koi stock kyun hila, ya koi anjaan term tap karo." },
  },
  market: {
    en: { name: "Against the Nifty 50", what: "What your trades made, next to what the same money would have made in the Nifty 50 on the same days. A small part of the grade, shown only after 4 weeks or 10 trades.",
      how: "Every rupee you put into a stock or fund is followed in the Nifty 50 for exactly the days you held it. Cash you kept aside is not compared with anything. Level with the Nifty is 50 out of 100; each 1% ahead or behind (of the most you had invested at once) moves it 3 points.",
      tryThis: "Most people who pick stocks trail the index in most years. Being close to it while you learn is a good result." },
    hi: { name: "Nifty 50 ke saamne", what: "Tumhare trades ne kitna banaya, aur wahi paisa unhi dino me Nifty 50 me hota to kitna banata. Grade ka chhota hissa, 4 hafte ya 10 trades ke baad hi dikhta hai.",
      how: "Jo bhi rupaya tumne stock ya fund me lagaya, use Nifty 50 me utne hi din follow kiya jaata hai jitne din tumne hold kiya. Jo cash alag rakha, uska kisi se compare nahi hota. Nifty ke barabar matlab 100 me 50; har 1% aage ya peeche (jitna sabse zyada ek saath lagaya tha uska) 3 point hilaata hai.",
      tryThis: "Stock chunne wale zyada log zyada saalon me index se peeche rehte hain. Seekhte hue uske paas rehna achha result hai." },
  },
};

const GRADE_TITLE = {
  en: { "A+": "Disciplined", "A": "Thoughtful", "B+": "Steady learner", "B": "Developing", "C": "Reactive", "D": "Needs a rethink" },
  hi: { "A+": "Disciplined", "A": "Soch samajh ke", "B+": "Steady learner", "B": "Seekh rahe ho", "C": "Reactive", "D": "Dobara socho" },
};

export const pillarName = (key, hi = false) => PILLARS[key]?.[hi ? "hi" : "en"]?.name || key;
export const pillarCopy = (key, hi = false) => PILLARS[key]?.[hi ? "hi" : "en"] || null;
export const gradeTitle = (grade, hi = false) => GRADE_TITLE[hi ? "hi" : "en"][grade] || "";

/** One line under the grade. */
export function overallSummary(overall, hi = false) {
  if (!overall) return "";
  if (overall.state !== "graded") {
    const u = overall.unlock || {};
    const left = Math.max(1, (u.need || 5) - (u.have || 0));
    return hi
      ? `Grade ${u.need || 5} trades ke baad milta hai. ${left} aur. Tab tak koi kharab grade nahi: neeche jo unlock ho chuka hai woh dekho.`
      : `Your grade unlocks after ${u.need || 5} trades. ${left} to go. No bad grade for being new: see what has already unlocked below.`;
  }
  if (overall.best && overall.worst) {
    return hi
      ? `Sabse mazboot: ${pillarName(overall.best, true)}. Sabse zyada gunjaish: ${pillarName(overall.worst, true)}.`
      : `Strongest: ${pillarName(overall.best)}. Most room to grow: ${pillarName(overall.worst)}.`;
  }
  return hi ? "Yeh grade tumhare faislon ka hai, sirf returns ka nahi." : "This grades your decisions, not just your returns.";
}

/** What unlocks a locked pillar. */
export function unlockText(pillarKey, unlock, hi = false) {
  const u = unlock || {};
  switch (u.key) {
    case "trades": {
      const left = Math.max(1, u.need - u.have);
      return hi ? `${u.need} trades ke baad khulta hai. Abhi ${u.have}, ${left} aur.` : `Unlocks after ${u.need} trades. You have ${u.have}, ${left} to go.`;
    }
    case "no_holdings":
      return hi ? "Jab tum koi stock ya fund hold karoge tab khulta hai." : "Unlocks when you hold a stock or fund.";
    case "small":
      return hi ? `Abhi sirf ${u.pct}% paisa laga hai, ek hi position me. ${u.need}% lagne par ya 2 holdings par khulta hai.` : `Only ${u.pct}% of your money is invested, in one position. Unlocks at ${u.need}% invested or 2 holdings.`;
    case "first_buy":
      return hi ? "Pehla stock ya fund kharidne par khulta hai." : "Unlocks with your first buy.";
    case "research": {
      const left = Math.max(1, u.need - u.have);
      return hi
        ? `${u.need} naye stock kharidne ke baad khulta hai (jisme pichhle 2 hafte trade nahi kiya). Abhi ${u.have}, ${left} aur.`
        : `Unlocks after ${u.need} buys of stocks you were not already trading. You have ${u.have}, ${left} to go.`;
    }
    case "learn":
      return hi
        ? `${u.need} learning actions par (crash replay, Saathi se sawaal, ya explainer) ya account 2 hafte purana hone par khulta hai. Abhi ${u.have}.`
        : `Unlocks with ${u.need} learning actions (a crash replay, a question to Saathi, an explainer) or once your account is 2 weeks old. You have ${u.have}.`;
    default:
      return hi ? "Abhi kaafi data nahi hai." : "Not enough data yet.";
  }
}

const OLD_LABEL = {
  en: { panic: "a sale right after a sharp fall", chase: "buying a stock that had already jumped", churn: "quick in-and-out trades in one stock", overtrade: "10 or more trades in a day", avg_down: "adding to a stock well below your cost", disposition: "selling a winner while holding losers" },
  hi: { panic: "tez girawat ke turant baad bechna", chase: "already uchhal chuka stock kharidna", churn: "ek hi stock me jaldi andar bahar", overtrade: "ek din me 10 ya zyada trade", avg_down: "cost se kaafi neeche stock me aur daalna", disposition: "winner bech ke losers pakde rehna" },
};

/** One fact from the core, as a sentence. */
export function factText(f, hi = false) {
  if (!f) return "";
  const n = f.n;
  switch (f.key) {
    // ---- discipline
    case "panic":
      return hi ? `Pichhle ${f.of} sells me se ${n} tez girawat ke turant baad, loss me ${n === 1 ? "tha" : "the"}.` : `${n} of your last ${f.of} sells came right after a sharp fall, at a loss.`;
    case "chase":
      return hi ? `Pichhle ${f.of} buys me se ${n} aise stock me ${n === 1 ? "tha" : "the"} jo pehle hi uchhal chuka tha.` : `${n} of your last ${f.of} buys ${n === 1 ? "was" : "were"} into a stock that had already jumped.`;
    case "churn":
      return hi ? `Ek hi stock me kuch dino ke andar baar baar andar bahar: ${n} baar note hua${f.symbol ? ` (latest: ${f.symbol})` : ""}.` : `In and out of the same stock within days: noted ${n} time${s(n)}${f.symbol ? ` (latest: ${f.symbol})` : ""}.`;
    case "overtrade":
      return hi ? `${n} baar tumne ek din me 10 ya zyada trade khud lagaye${f.peak >= 10 ? ` (sabse zyada: ${f.peak})` : ""}.` : `${n} time${s(n)} you crossed 10 or more hand-placed trades in a day${f.peak >= 10 ? ` (most: ${f.peak})` : ""}.`;
    case "avg_down":
      return hi ? `Pichhle ${f.of} buys me se ${n} aise stock me aur daalna tha jo tumhari cost se kaafi neeche tha.` : `${n} of your last ${f.of} buys added to a stock that was well below what you paid.`;
    case "disposition":
      return hi ? `${n} baar tumne winner becha jabki 10%+ neeche wale stock pakde rahe.` : `${n} time${s(n)} you sold a winner while holding stocks that were 10% or more down.`;
    case "panic_old": case "chase_old": case "churn_old": case "overtrade_old": case "avg_down_old": case "disposition_old": {
      const k = f.key.replace("_old", "");
      return hi ? `${f.days} din purana note abhi thoda ginta hai: ${OLD_LABEL.hi[k]}.` : `A note from ${f.days} days ago still counts a little: ${OLD_LABEL.en[k]}.`;
    }
    case "clean":
      return hi ? `${f.days} din me ${f.trades} trades: na panic sell, na peeche bhaagna, na churning.` : `No panic sells, chasing or churning in your ${f.trades} trades over ${f.days} day${s(f.days)}.`;
    case "young":
      return hi ? `Tumhara record ${f.days} din purana hai. Yeh score ${f.full} din me pakka hota hai.` : `Your record is ${f.days} day${s(f.days)} old. This score settles over ${f.full} days.`;
    case "record":
      return hi ? `${f.days} din ke ${f.trades} trades gine gaye.` : `${f.trades} trades over ${f.days} days counted.`;
    case "improving":
      return hi
        ? `Sudhar ho raha hai: pehle har 10 trades me ${f.before} note, pichhle 30 din me ${f.now}.`
        : `Getting better: ${f.before} notes per 10 trades before, ${f.now} in the last 30 days.`;
    case "slipping":
      return hi
        ? `Dhyan do: pehle har 10 trades me ${f.before} note, pichhle 30 din me ${f.now}.`
        : `Watch this: ${f.before} notes per 10 trades before, ${f.now} in the last 30 days.`;
    // ---- results
    case "profit":
      return hi
        ? `Tumne ${rupees(f.plPaise)} banaye, sabse zyada lagaye paise (${rupees(f.peakPaise)}) par ${f.pct}%.`
        : `You made ${rupees(f.plPaise)}, ${f.pct}% on the most you had invested at once (${rupees(f.peakPaise)}).`;
    case "loss":
      return hi
        ? `Tumne ${rupees(f.plPaise)} gawaye, sabse zyada lagaye paise (${rupees(f.peakPaise)}) par ${f.pct}%.`
        : `You lost ${rupees(f.plPaise)}, ${f.pct}% on the most you had invested at once (${rupees(f.peakPaise)}).`;
    case "drawdown":
      return hi
        ? `Sabse buri girawat: account apne high se ${rupees(f.dropPaise)} neeche gaya (lagaye paise ka ${f.pct}%).`
        : `Worst fall: your account dropped ${rupees(f.dropPaise)} below its high (${f.pct}% of the money invested).`;
    case "closed":
      return hi
        ? `Band hui positions: ${f.wins} jeeti, ${f.losses} haari, ${f.evens} barabar.`
        : `Closed positions: ${f.wins} won, ${f.losses} lost, ${f.evens} even.`;
    case "results_young":
      return hi ? `Record ${f.days} din purana hai. Yeh score ${f.full} din me pakka hota hai.` : `Your record is ${f.days} day${s(f.days)} old. This score settles over ${f.full} days.`;
    // ---- research
    case "researched":
      return hi
        ? `Pichhle ${f.of} naye buys me se ${f.n} se pehle tumne stock ko dekha-parkha.`
        : `${f.n} of your last ${f.of} new buys came after you looked into the stock first.`;
    case "impulse":
      return hi
        ? `${f.of} me se ${f.n} buys stock pehli baar kholne ke kuch minute me, bina research ke.`
        : `${f.n} of ${f.of} were bought within minutes of first opening the stock, with no research.`;
    case "research_ways": {
      const bits = hi
        ? [f.views ? `${f.views} baar pehle din page dekha` : "", f.chart ? `${f.chart} baar chart` : "", f.watch ? `${f.watch} baar watchlist` : "", f.asked ? `${f.asked} baar Saathi se pucha` : ""]
        : [f.views ? `earlier visits ${f.views}` : "", f.chart ? `chart ${f.chart}` : "", f.watch ? `watchlist ${f.watch}` : "", f.asked ? `asked Saathi ${f.asked}` : ""];
      return (hi ? "Kaise dekha: " : "How you looked: ") + bits.filter(Boolean).join(", ") + ".";
    }
    // ---- diversification
    case "top_stock":
      return hi ? `Tumhara sabse bada stock, ${f.name}, poore paise ka ${f.pct}% hai.` : `Your biggest stock, ${f.name}, is ${f.pct}% of all your money.`;
    case "positions":
      return hi
        ? `Tumhare paas ${f.n} position${s(f.n)} ${s(f.n, "hai", "hain")}${f.funds ? `, jisme ${f.funds} fund ya ETF` : ""}.`
        : `You hold ${f.n} position${s(f.n)}${f.funds ? `, ${f.funds} of them a fund or ETF` : ""}.`;
    case "top_sector":
      return hi ? `Stock ke paise ka ${f.pct}% ${f.sector} me hai (${f.n} stock${s(f.n)}).` : `${f.pct}% of your stock money is in ${f.sector} (${f.n} stock${s(f.n)}).`;
    case "cash":
      return hi ? `${f.pct}% cash me hai. Seekhte waqt yeh theek hai.` : `${f.pct}% is in cash. That is fine while you learn.`;
    case "cash_idle":
      return hi ? `${f.pct}% ek mahine se zyada se cash me pada hai.` : `${f.pct}% has sat in cash for over a month.`;
    // ---- learning
    case "weeks":
      return hi ? `Pichhle ${f.of} hafte${s(f.of, "", "")} me se ${f.active} me tumne app khola.` : `You opened the app in ${f.active} of the last ${f.of} week${s(f.of)}.`;
    case "actions": {
      const bits = hi
        ? [f.replays ? `${f.replays} crash replay poore` : "", f.questions ? `Saathi se ${f.questions} sawaal` : "", f.reads ? `${f.reads} explainer padhe` : ""]
        : [f.replays ? `${f.replays} crash replay${s(f.replays)} finished` : "", f.questions ? `${f.questions} question${s(f.questions)} to Saathi` : "", f.reads ? `${f.reads} explainer${s(f.reads)} read` : ""];
      return (hi ? "Is dauraan: " : "In that time: ") + bits.filter(Boolean).join(", ") + ".";
    }
    case "no_actions":
      return hi ? "Is dauraan koi crash replay, Saathi se sawaal ya explainer nahi." : "No crash replay, question to Saathi or explainer in that time.";
    case "untried": {
      const bits = hi
        ? [!f.replays ? "crash replay" : "", !f.questions ? "Saathi se sawaal" : "", !f.reads ? "explainer" : ""]
        : [!f.replays ? "a crash replay" : "", !f.questions ? "a question to Saathi" : "", !f.reads ? "an explainer" : ""];
      return (hi ? "Abhi try nahi kiya: " : "Not tried yet: ") + bits.filter(Boolean).join(", ") + ".";
    }
    // ---- market
    case "vs_nifty": {
      const you = f.youPaise >= 0 ? (hi ? `${rupees(f.youPaise)} banaye` : `made ${rupees(f.youPaise)}`) : (hi ? `${rupees(f.youPaise)} gawaye` : `lost ${rupees(f.youPaise)}`);
      const idx = f.niftyPaise >= 0 ? (hi ? `${rupees(f.niftyPaise)} banata` : `would have made ${rupees(f.niftyPaise)}`) : (hi ? `${rupees(f.niftyPaise)} gawata` : `would have lost ${rupees(f.niftyPaise)}`);
      return hi
        ? `${dateText(f.sinceTs)} se tumhare trades ne ${you}. Wahi paisa unhi dino me Nifty 50 me ${idx}.`
        : `Since ${dateText(f.sinceTs)} your trades ${you}. The same money in the Nifty 50 on the same days ${idx}.`;
    }
    default:
      return "";
  }
}

/** Plain-English lines for the AI card's prompt (always English). */
export function promptLines(rc) {
  const out = [];
  const o = rc?.overall || {};
  out.push(o.state === "graded" ? `Overall grade: ${o.grade} (${o.score}/100)` : "Overall grade: not graded yet (needs 5 trades)");
  for (const p of Object.values(rc?.pillars || {})) {
    if (p.state === "hidden" || p.state === "pending") continue;
    const head = `${pillarName(p.key)} (${p.weight}% of the grade): ` + (p.state === "scored" ? `${p.score}/100` : `locked. ${unlockText(p.key, p.unlock)}`);
    out.push(head);
    for (const f of p.facts || []) { const t = factText(f); if (t) out.push(`  - ${t}`); }
  }
  return out;
}
