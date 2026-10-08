'use strict';

const { URGENCY } = require('./herdr');

// エージェント → スロット番号 の割り当て。
// sticky: 一度割り当てた番号は、そのエージェントが終了するまで変えない (空いた番号は次の新顔が使う)。
//         「左上のキーは api のエージェント」と覚えられるようにするため。
// priority: 毎回 確認待ち→完了→作業中→待機 の順に詰め直す。
class SlotBook {
  constructor() {
    this.byId = new Map();
    this.since = new Map(); // id -> { status, at }
  }

  update(agents, now = Date.now()) {
    const live = new Set(agents.map((a) => a.id));
    for (const id of [...this.byId.keys()]) if (!live.has(id)) this.byId.delete(id);
    for (const id of [...this.since.keys()]) if (!live.has(id)) this.since.delete(id);

    const used = new Set(this.byId.values());
    for (const agent of agents) {
      if (!this.byId.has(agent.id)) {
        let slot = 0;
        while (used.has(slot)) slot += 1;
        this.byId.set(agent.id, slot);
        used.add(slot);
      }
      const prev = this.since.get(agent.id);
      if (!prev || prev.status !== agent.status) this.since.set(agent.id, { status: agent.status, at: now });
    }
  }

  // index 番目のキーに表示するエージェント (無ければ null)
  layout(agents, order = 'sticky') {
    if (order === 'priority') {
      return [...agents].sort((x, y) => URGENCY[x.status] - URGENCY[y.status]);
    }
    const slots = [];
    for (const agent of agents) {
      const slot = this.byId.get(agent.id);
      if (slot !== undefined) slots[slot] = agent;
    }
    return slots;
  }

  statusSince(id) {
    return this.since.get(id)?.at ?? null;
  }
}

// デバイス上のキー位置 (行→列) の順に、エージェント用キーへ 0,1,2... の番号を振る。
function orderKeys(keys) {
  return [...keys]
    .sort((a, b) =>
      String(a.device).localeCompare(String(b.device))
      || a.row - b.row
      || a.column - b.column
      || String(a.context).localeCompare(String(b.context)))
    .map((k) => k.context);
}

module.exports = { SlotBook, orderKeys };
