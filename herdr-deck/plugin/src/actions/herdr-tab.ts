import type { DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { action, SingletonAction } from "@elgato/streamdeck";
import type { DeckController } from "../core/deck-controller.ts";
import { parseSlot } from "../core/deck-controller.ts";

type TabKeySettings = {
  /** 1始まりのタブ番号。空なら位置で自動割り当て */
  slot?: number | string | null;
};

/**
 * Stream Deck (Elgato SDK) 用の薄いアダプタ。振る舞いは DeckController にある。
 * DeckController の KeySink は plugin.ts で this.actions から実装する。
 */
@action({ UUID: "com.kuruusuniku.herdr-deck.tab" })
export class HerdrTabAction extends SingletonAction<TabKeySettings> {
  controller: DeckController | null = null;

  override onWillAppear(ev: WillAppearEvent<TabKeySettings>): void {
    if (!ev.action.isKey()) return;
    this.controller?.keyAppear({
      id: ev.action.id,
      device: ev.action.device.id,
      column: ev.action.coordinates?.column,
      row: ev.action.coordinates?.row,
      slot: parseSlot(ev.payload.settings.slot),
    });
  }

  override onWillDisappear(ev: WillDisappearEvent<TabKeySettings>): void {
    this.controller?.keyDisappear(ev.action.id);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TabKeySettings>): void {
    this.controller?.keySettings(ev.action.id, parseSlot(ev.payload.settings.slot));
  }

  override onKeyDown(ev: KeyDownEvent<TabKeySettings>): void {
    this.controller?.keyDown(ev.action.id);
  }

  override async onKeyUp(ev: KeyUpEvent<TabKeySettings>): Promise<void> {
    await this.controller?.keyUp(ev.action.id);
  }
}
