"use strict";

(function exposeKakeizuSamples(root, factory) {
  const samples = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = samples;
  } else {
    root.KakeizuSamples = samples;
  }
})(globalThis, function createKakeizuSamples() {
  const catalog = Object.freeze([
    Object.freeze({
      id: "blank",
      title: "空白から作成",
      description: "人物0人から、架空の家族図を自由に作成します。",
      diagram: "人物を追加 → 関係をつなぐ",
    }),
    Object.freeze({
      id: "basic",
      title: "基本の3世代",
      description: "架空のサンプル家6人で、祖父母・被相続人と配偶者・子2人の3世代を示します。長男・長女の出生順も架空の設定です。",
      diagram: "祖父母 → 被相続人と配偶者 → 子2人",
    }),
    Object.freeze({
      id: "couple-children", title: "夫婦と子2人",
      description: "架空のサンプル家4人で、夫婦と子2人の親子関係を示します。長男・長女の出生順も架空の設定です。",
      diagram: "夫婦 → 子2人",
    }),
    Object.freeze({
      id: "single-parent", title: "ひとり親と子2人",
      description: "架空のサンプル家3人で、登録する親は1人、子は2人です。もう一方の親の法的状態は示さず、長男・長女の出生順も架空の設定です。",
      diagram: "登録した親1人 → 子2人",
    }),
    Object.freeze({
      id: "childless-couple", title: "子のいない夫婦と双方の親・兄弟",
      description: "架空のサンプル家と見本家8人で、子のいない夫婦と双方の親・弟・妹を示します。弟・妹の出生順も架空の設定です。",
      diagram: "双方の親 → 夫婦・それぞれの兄弟",
    }),
    Object.freeze({
      id: "siblings", title: "兄弟姉妹と配偶者・甥姪",
      description: "架空のサンプル家と見本家11人で、両親・兄弟姉妹3人と各配偶者・甥姪の関係を示します。兄・妹の出生順も架空の設定です。",
      diagram: "両親 → 兄・本人・妹と配偶者 → 甥姪",
    }),
    Object.freeze({
      id: "deceased-parent", title: "死亡した親を含む家族",
      description: "架空のサンプル家4人で、死亡した父と母・子2人の親子関係を示します。死亡年月日と長男・長女の出生順も架空の設定です。",
      diagram: "父（死亡）・母 → 子2人",
    }),
    Object.freeze({
      id: "remarriage",
      title: "再婚のある家族",
      description: "架空の7人家族で、本人・前妻・現妻と、それぞれの婚姻の子2人ずつを示します。前婚の長男・長女と再婚後の次男・次女の出生順も架空の設定です。",
      diagram: "前妻 ─ 本人 ─ 現妻 / 各婚の子2人",
    }),
    Object.freeze({
      id: "four-generations", title: "4世代の家族",
      description: "架空のサンプル家7人で、曾祖父母から曾孫まで4世代のつながりを示します。最下世代の長男という出生順も架空の設定です。",
      diagram: "曾祖父母 → 祖父母 → 父母 → 長男",
    }),
  ]);

  // 詳細カードの最大寸法（190 × 132）にも重ならない余白を取る。
  function person(id, name, gender, x, y, relation) {
    return { id, name, relation, gender, parents: [], spouses: [], x, y };
  }

  function createSample(kind) {
    let people;
    let families;

    switch (kind) {
      case "blank":
        return { people: [], families: [], annotations: [] };
      case "basic":
        people = [
          person("P001", "サンプル 正雄", "男性", 120, 80, "祖父"),
          person("P002", "サンプル 和子", "女性", 350, 80, "祖母"),
          person("P003", "サンプル 隆志", "男性", 235, 292, "被相続人"),
          person("P004", "サンプル 真由美", "女性", 465, 292, "配偶者"),
          person("P005", "サンプル 翔太", "男性", 235, 504, "長男"),
          person("P006", "サンプル 美咲", "女性", 465, 504, "長女"),
        ];
        families = [
          { id: "F001", parents: ["P001", "P002"], children: ["P003"] },
          { id: "F002", parents: ["P003", "P004"], children: ["P005", "P006"] },
        ];
        break;
      case "remarriage":
        people = [
          person("P001", "見本 美和", "女性", 235, 120, "前妻"),
          person("P002", "サンプル 亮介", "男性", 465, 120, "本人"),
          person("P003", "サンプル 由香", "女性", 695, 120, "現妻"),
          person("P004", "サンプル 翔太", "男性", 120, 332, "長男（前婚）"),
          person("P005", "サンプル 菜々", "女性", 350, 332, "長女（前婚）"),
          person("P006", "サンプル 悠真", "男性", 580, 332, "次男（再婚後）"),
          person("P007", "サンプル 美咲", "女性", 810, 332, "次女（再婚後）"),
        ];
        families = [
          { id: "F001", parents: ["P001", "P002"], children: ["P004", "P005"] },
          { id: "F002", parents: ["P002", "P003"], children: ["P006", "P007"] },
        ];
        break;
      case "couple-children":
        people = [
          person("P001", "サンプル 太郎", "男性", 120, 100, "父"),
          person("P002", "サンプル 花子", "女性", 350, 100, "母"),
          person("P003", "サンプル 陽", "男性", 120, 312, "長男"),
          person("P004", "サンプル 葵", "女性", 350, 312, "長女"),
        ];
        families = [{ id: "F001", parents: ["P001", "P002"], children: ["P003", "P004"] }];
        break;
      case "single-parent":
        people = [
          person("P001", "サンプル 美咲", "女性", 235, 100, "母"),
          person("P002", "サンプル 翔", "男性", 120, 312, "長男"),
          person("P003", "サンプル 凛", "女性", 350, 312, "長女"),
        ];
        families = [{ id: "F001", parents: ["P001"], children: ["P002", "P003"] }];
        break;
      case "childless-couple":
        people = [
          person("P001", "サンプル 正", "男性", 120, 100, "夫の父"),
          person("P002", "サンプル 和子", "女性", 350, 100, "夫の母"),
          person("P003", "見本 誠", "男性", 810, 100, "妻の父"),
          person("P004", "見本 恵", "女性", 1040, 100, "妻の母"),
          person("P005", "サンプル 健", "男性", 350, 312, "夫"),
          person("P006", "サンプル 結衣", "女性", 580, 312, "妻"),
          person("P007", "サンプル 直樹", "男性", 120, 312, "夫の弟"),
          person("P008", "見本 彩", "女性", 1040, 312, "妻の妹"),
        ];
        families = [
          { id: "F001", parents: ["P001", "P002"], children: ["P005", "P007"] },
          { id: "F002", parents: ["P003", "P004"], children: ["P006", "P008"] },
          { id: "F003", parents: ["P005", "P006"], children: [] },
        ];
        break;
      case "siblings":
        people = [
          person("P001", "サンプル 修", "男性", 580, 100, "父"),
          person("P002", "サンプル 幸", "女性", 810, 100, "母"),
          person("P003", "サンプル 大地", "男性", 120, 312, "兄"),
          person("P004", "サンプル 春香", "女性", 350, 312, "兄の妻"),
          person("P005", "サンプル 光", "男性", 580, 312, "本人"),
          person("P006", "サンプル 夏希", "女性", 810, 312, "配偶者"),
          person("P007", "見本 詩織", "女性", 1040, 312, "妹"),
          person("P008", "見本 海", "男性", 1270, 312, "妹の夫"),
          person("P009", "サンプル 悠", "男性", 120, 524, "甥"),
          person("P010", "サンプル 花", "女性", 350, 524, "姪"),
          person("P011", "見本 紬", "女性", 1155, 524, "姪"),
        ];
        families = [
          { id: "F001", parents: ["P001", "P002"], children: ["P003", "P005", "P007"] },
          { id: "F002", parents: ["P003", "P004"], children: ["P009", "P010"] },
          { id: "F003", parents: ["P005", "P006"], children: [] },
          { id: "F004", parents: ["P007", "P008"], children: ["P011"] },
        ];
        break;
      case "four-generations":
        people = [
          person("P001", "サンプル 一郎", "男性", 120, 100, "曾祖父"),
          person("P002", "サンプル 千代", "女性", 350, 100, "曾祖母"),
          person("P003", "サンプル 二郎", "男性", 235, 312, "祖父"),
          person("P004", "サンプル 文", "女性", 465, 312, "祖母"),
          person("P005", "サンプル 三郎", "男性", 350, 524, "父"),
          person("P006", "サンプル 翠", "女性", 580, 524, "母"),
          person("P007", "サンプル 明", "男性", 465, 736, "長男"),
        ];
        families = [
          { id: "F001", parents: ["P001", "P002"], children: ["P003"] },
          { id: "F002", parents: ["P003", "P004"], children: ["P005"] },
          { id: "F003", parents: ["P005", "P006"], children: ["P007"] },
        ];
        break;
      case "deceased-parent":
        people = [
          { ...person("P001", "サンプル 和夫", "男性", 120, 100, "父"), birth: "1950-04-12", death: "2020-09-18", deceased: true },
          person("P002", "サンプル 洋子", "女性", 350, 100, "母"),
          person("P003", "サンプル 亮", "男性", 120, 312, "長男"),
          person("P004", "サンプル 咲", "女性", 350, 312, "長女"),
        ];
        families = [{ id: "F001", parents: ["P001", "P002"], children: ["P003", "P004"] }];
        break;
      default:
        throw new RangeError("未知のサンプル種別です。");
    }

    // familyを正として、既存createPersonに渡す親・配偶者の参照も揃える。
    const byId = new Map(people.map(entry => [entry.id, entry]));
    for (const family of families) {
      for (const parentId of family.parents) {
        const parent = byId.get(parentId);
        for (const spouseId of family.parents) {
          if (spouseId !== parentId && !parent.spouses.includes(spouseId)) {
            parent.spouses.push(spouseId);
          }
        }
      }
      for (const childId of family.children) {
        byId.get(childId).parents = family.parents.slice();
      }
    }

    return { people, families, annotations: [] };
  }

  return { catalog, createSample };
});
