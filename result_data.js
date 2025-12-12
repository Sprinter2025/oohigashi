// result_data.js
// 結果画面用：スコア帯ごとの画像＆コメント（コメントはランダム選択）
//
// 仕様：
// - 0~100, 101~200, 201~300, 301~400, 401~500, 501~
// - 各帯に img 1枚 + comments 複数
// - img は assets/ 以下を想定（好きに変えてOK）

window.RESULT_PACKS = [
  {
    min: 0, max: 100,
    img: "./assets/result/0-100.png",
    comments: [
      "手先とか不器用な感じ？",
      "ウォーミングアップだよね，さすがに",
      "そろそろ利き手使おうか"
    ],
  },
  {
    min: 101, max: 200,
    img: "./assets/result/101-200.png",
    comments: [
      "おい，笑える",
      "逆に才能あるよ...w",
      "それでよく挑んだね，このゲーム"
    ],
  },
  {
    min: 201, max: 300,
    img: "./assets/result/201-300.png",
    comments: [
      "そろそろ本気でやろっか",
      "もう帰っていいですか？",
      "君のプレイ，眠たくなるね"
    ],
  },
  {
    min: 301, max: 400,
    img: "./assets/result/301-400.png",
    comments: [
      "なかなかやるじゃん？",
      "その調子，その調子",
      "見ぃつけた"
    ],
  },
  {
    min: 401, max: 500,
    img: "./assets/result/401-500.png",
    comments: [
      "最近ちょっと太った？",
      "鼻の下，ニキビできてるよ",
      "やっと2人きりになれたね？"
    ],
  },
  {
    min: 501, max: null, // null = 上限なし（501~）
    img: "./assets/result/501plus.png",
    comments: [
      "よし，妻にしてやるえ",
      "2億で買うえ"
    ],
  },
];
