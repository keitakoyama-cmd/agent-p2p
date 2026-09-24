<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent P2P 実装エージェント向け指示

署名付きP2P通信、タスク実行、トークン・エスクロー、Solana/EVM/Pump.fun のオンチェーン経路を持つ Next.js / TypeScript プロジェクト。コード変更が秘密鍵漏洩や実送金に直結し得る。全域の規律は `~/.codex/AGENTS.md`、このrepo固有の手順・危険領域は本ファイル。

## セットアップ・コマンド

- 作業ディレクトリはこのファイルと `package.json` がある `active/apps/agent-p2p/`。
- パッケージマネージャは npm。今回の検証環境には既存の `node_modules` がある。
- 依存導入、対話セットアップ、デーモン起動、production build は今回未検証。特に `scripts/setup-agent.sh` はホーム配下へのデータ作成、鍵生成、デーモン起動、MCP登録を伴うため、検証目的で実行しない。
- 実走確認済みのコマンドは次節の4本だけ。`package.json` と `.github/workflows/ci.yml` の実体を確認してから変更する。

## 実装前後の検証手順

変更前に対象経路と対応テストを読む。変更後は次を上から順に実行し、赤を含めて終了コードと件数をそのまま報告する。

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

2026-07-15 の実測結果:

- typecheck: exit 0。
- lint: exit 1、35 errors / 12 warnings。これは現在の既知ベースラインであり、緑と報告しない。自分の変更で新規違反を増やしていないか差分を確認する。
- test: 243 passed / 0 failed。
- test:e2e: **同じ日に2回走らせて結果が割れた（＝フレークは実在する）**。
  - 1回目: exit 1、83 pass / **5 cancelled**。cancelled はすべて `test_e2e_economic` の P2P 転送で、DHT の招待受諾が成立しなかった。EVM / project / routes / security は通過。
  - 2回目: exit 0、88 passed / 0 failed。
  - 原因は `--test-concurrency=1` で一時デーモン・ローカルポート・Ganache・**実 Hyperswarm DHT** を使うため。DHT はネットワークのタイミングに依存し、成否が run ごとに変わる。
  - **したがって「1回緑だった」を根拠にしない。赤が出たら赤のまま報告する。** DHT依存分（economic の P2P 転送）が落ちたのか、それ以外が落ちたのかを必ず切り分けて書くこと。後者なら本物の回帰である。
  - サンドボックスでは `tsx` の IPC ソケット作成が `EPERM` になることがある。その場合は環境制約として報告し、テスト成功に置き換えない。

CI は typecheck と unit test のみで、E2E は実行しない。件数や成否は毎回の実出力を正とする。package script `test:integration` は今回未検証で、外部 Solana devnet とSOLを必要とするため明示承認なしに実行しない。

## 危険領域

- `agent-state.json` は Ed25519 秘密鍵を保持する。パスフレーズが無い場合は平文保存へフォールバックする実装なので、内容を読まない・出力しない・コミットしない。暗号化・復号・鍵導出に関わる `src/agent/core.ts`、`src/lib/crypto/keystore.ts`、`src/daemon/signing.ts` は高リスク領域。
- `api-token`、パスフレーズ、APIキー、認証設定の値を読まない・ログへ出さない。秘密情報ファイルをテストfixtureに転用しない。
- `economic-state.json` はトークン、ウォレット、エスクロー、台帳を永続化する。削除・上書き・形式変更は資産状態を失うため、migration と後方互換を含む明示設計なしに変更しない。
- `src/lib/economic/`、`src/daemon/economic-state.ts`、`src/daemon/routes/economic.ts` は残高・送金・エスクロー経路。`src/lib/chain/`、`src/daemon/routes/solana.ts`、`src/daemon/routes/pumpfun.ts` は実ネットワーク上の発行・mint・送金・売買へ到達する。変更には司令塔の確認と、実資産を使わない決定的テストが必要。
- mainnet、Pump.fun、外部RPC、実ウォレットを使うコマンドやHTTPリクエストは実行しない。テスト用でも実SOLのairdrop・送金・token launchを行わない。
- `scripts/mainnet-test.ts` と `scripts/pumpfun-launch.ts` は**実トークンの発行・mint・送金・売買を起こし得る**。実行しない。
- `scripts/setup-agent.sh` はホーム配下へのデータ作成・鍵生成・デーモン起動・MCP登録を伴う。検証目的で実行しない。
- P2P受信、handshake、署名検証、task policy、file transfer の変更は認証回避・なりすまし・path traversal・credential流出に直結する。対応する security / handshake / traversal テストを削らない。
- `site/` の公開、Wrangler/Cloudflareへのdeploy、外部ディレクトリ登録、MCP登録は外部状態を変えるため実行しない。

## 実装範囲と完了条件

- TypeScript strict を維持し、`as any` を追加しない。送金額・宛先・chain/network・署名対象を暗黙の既定値で緩めない。
- 経済・鍵・P2Pセキュリティ経路の変更では、成功系だけでなく不足残高、二重実行、改ざん署名、再起動後の永続化を対応テストで確認する。
- 指定外ファイルを変更せず、4コマンドの実出力を報告する。lint の既知失敗や環境起因のE2E失敗を pass と書かない。
- 終了時は変更ファイル、各検証の exit code と件数、未検証事項、`git status --porcelain` の実出力を報告する。commit / push / branch 作成は行わない。
