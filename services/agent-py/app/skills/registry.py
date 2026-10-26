"""技能注册表：按触发词命中，给出当前最匹配的技能。

匹配用最朴素的子串覆盖度，不引分词器：
中文技能触发词本身就是完整词（"退货""物流""投诉"），子串命中足够稳，
且不会像 bigram 那样把"退货"和"换货"混成一个模糊分。
"""

from __future__ import annotations

import logging
import re
from typing import Iterable

from .types import ActiveSkill, Skill

log = logging.getLogger("skills")

_WS = re.compile(r"\s+")


def normalize(text: str) -> str:
    return _WS.sub("", (text or "").lower())


class SkillRegistry:
    def __init__(self, skills: Iterable[Skill] | None = None) -> None:
        self._skills: dict[str, Skill] = {}
        if skills:
            self.register(*skills)

    def register(self, *skills: Skill) -> None:
        for skill in skills:
            self._skills[skill.name] = skill

    def get(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def all(self) -> list[Skill]:
        return list(self._skills.values())

    def __len__(self) -> int:
        return len(self._skills)

    def match(self, question: str) -> ActiveSkill | None:
        text = normalize(question)
        if not text:
            return None

        best: ActiveSkill | None = None
        for skill in self._skills.values():
            hits = [t for t in skill.triggers if t and normalize(t) in text]
            if len(hits) < skill.min_hits:
                continue

            # 覆盖度：命中触发词总长度 / 问题长度；命中个数与优先级只做微调
            coverage = sum(len(normalize(t)) for t in hits) / max(len(text), 1)
            score = coverage + 0.05 * len(hits) + skill.priority * 0.001

            if best is None or score > best.score:
                best = ActiveSkill(skill=skill, score=score, matched=hits)

        if best is not None:
            log.info(
                "技能命中: %s（%.2f，触发词 %s）",
                best.skill.name,
                best.score,
                "、".join(best.matched),
            )
        return best

    def describe(self) -> list[dict]:
        return [
            {
                "name": s.name,
                "title": s.title,
                "description": s.description,
                "triggers": list(s.triggers),
                "tools": list(s.tools),
                "priority": s.priority,
            }
            for s in self._skills.values()
        ]
