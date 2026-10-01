export interface KeyPlacement {
  id: string;
  device: string;
  column?: number;
  row?: number;
  /** プロパティインスペクタで指定した番号 (1始まり)。未指定なら位置で自動割り当て */
  slot?: number | null;
}

/**
 * ボタンにタブの番号 (0始まり) を割り当てる。
 *
 * - 番号を指定したボタン: その番号のタブ
 * - 指定していないボタン: デバイスごとに 上の行→下の行、左→右 の順で、空いている番号を若い順に埋める
 */
export function assignSlots(keys: KeyPlacement[]): Map<string, number> {
  const result = new Map<string, number>();
  const taken = new Set<number>();
  for (const k of keys) {
    if (k.slot && Number.isInteger(k.slot) && k.slot >= 1) {
      result.set(k.id, k.slot - 1);
      taken.add(k.slot - 1);
    }
  }
  const auto = keys
    .filter((k) => !result.has(k.id))
    .sort(
      (a, b) =>
        a.device.localeCompare(b.device) ||
        (a.row ?? 0) - (b.row ?? 0) ||
        (a.column ?? 0) - (b.column ?? 0) ||
        a.id.localeCompare(b.id),
    );
  let next = 0;
  for (const k of auto) {
    while (taken.has(next)) next++;
    result.set(k.id, next);
    taken.add(next);
  }
  return result;
}
