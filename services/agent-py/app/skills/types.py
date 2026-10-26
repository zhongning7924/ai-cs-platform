"""技能契约：一个技能 = 触发条件 + 注入指令 + 工具偏好。

技能不是"权限"，而是"上下文增强"：
命中后只往系统提示里补一段领域指令、并把相关工具排到前面，
不会禁止模型调用其它工具——避免把动作类意图锁死（这是规则通道踩过的坑）。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Skill:
    name: str
    title: str
    description: str
    triggers: tuple[str, ...]
    instructions: str
    tools: tuple[str, ...] = ()
    priority: int = 0
    min_hits: int = 1


@dataclass
class ActiveSkill:
    """一次命中的结果，随 PlannerContext 流进规划器。"""

    skill: Skill
    score: float
    matched: list[str] = field(default_factory=list)

    def prompt_block(self) -> str:
        lines = [f"\n\n【当前激活技能】{self.skill.title}（{self.skill.name}）"]
        lines.append(self.skill.instructions.strip())
        if self.skill.tools:
            lines.append(f"\n本技能优先使用工具：{'、'.join(self.skill.tools)}；其它工具仍可按需调用。")
        return "\n".join(lines)

    def to_wire(self) -> dict:
        return {
            "name": self.skill.name,
            "title": self.skill.title,
            "score": round(self.score, 3),
            "matched": self.matched,
        }
