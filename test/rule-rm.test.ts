import { describe, expect, it } from 'vitest'
import type { UserRule } from '../src/runtime/user-rules.js'
import { dependentsOf } from '../src/cli/rule-rm.js'

/**
 * `nucleus rule rm` —— 这个命令原先**不存在**。
 *
 * 只有 `rule new`。删一条规则得自己 `rm rules/foo.md`，而那样做看不见
 * 你删掉了什么：它可能正在给某个 agent 加必填字段，也可能正被别的规则依赖。
 *
 * 使用者的分类是对的：规则只有**增加、更新、删除**三种操作。
 * 「覆盖」不是其中一种 —— 它只是「更新但先把现有的扔了」，
 * 而那从来不是想要的。所以 `--force` 删掉了。
 */

const rule = (over: Partial<UserRule> & { id: string }): UserRule => ({
  constraint: null,
  gist: null,
  check: null,
  denyTools: [],
  appliesTo: ['*'],
  uncovered: [],
  path: `rules/${over.id}.md`,
  ...over,
})

const declares = (id: string, field: string) =>
  rule({
    id,
    check: {
      resultFields: { [field]: { type: 'object[]', fields: { step: 'string' } } },
      requiredFields: [`${field}[].step`],
    },
  })

const requires = (id: string, ...fields: string[]) =>
  rule({ id, check: { requiredFields: fields } })

describe('删之前查依赖', () => {
  /**
   * **这是删除唯一会「让别的东西坏掉」的方式。**
   *
   * 规则 A 声明 `plan`、规则 B 要求 `plan[].step`：删掉 A 之后 B 引用一个
   * 未声明的字段，加载器会拒 —— 而报错指向 B，**不指向「你刚删了 A」**。
   * 那种错误最难查：你以为自己动的是 A。
   */
  it('别的规则要求了它声明的字段 → 报出来', () => {
    const rules = [declares('plan-first', 'plan'), requires('needs-plan', 'plan[].step')]
    const out = dependentsOf(rules, 'plan-first')
    expect(out).toHaveLength(1)
    expect(out[0]!.rule.id).toBe('needs-plan')
    expect(out[0]!.fields).toEqual(['plan[].step'])
  })

  it('要求核心字段的规则不算依赖 —— 那些字段一直都在', () => {
    const rules = [declares('plan-first', 'plan'), requires('x', 'summary', 'confidence')]
    expect(dependentsOf(rules, 'plan-first')).toEqual([])
  })

  it('只挑出真正引用到的那几个字段路径', () => {
    const rules = [
      declares('plan-first', 'plan'),
      requires('mixed', 'summary', 'plan[].step', 'plan'),
    ]
    expect(dependentsOf(rules, 'plan-first')[0]!.fields).toEqual(['plan[].step', 'plan'])
  })

  /** 自己要求自己声明的字段是常态，不该算依赖 —— 否则任何规则都删不掉 */
  it('不把自己算成依赖者', () => {
    expect(dependentsOf([declares('plan-first', 'plan')], 'plan-first')).toEqual([])
  })

  it('纯边界规则没有字段可依赖', () => {
    const rules = [rule({ id: 'no-writes', denyTools: ['write_file'] }), requires('x', 'summary')]
    expect(dependentsOf(rules, 'no-writes')).toEqual([])
  })

  it('多个依赖者全部列出 —— 只报一个会让人以为改完就能删', () => {
    const rules = [
      declares('plan-first', 'plan'),
      requires('a', 'plan[].step'),
      requires('b', 'plan[].why'),
    ]
    expect(dependentsOf(rules, 'plan-first').map((x) => x.rule.id)).toEqual(['a', 'b'])
  })

  it('要删的 id 不存在时返回空，而不是抛', () => {
    expect(dependentsOf([declares('a', 'plan')], 'nope')).toEqual([])
  })
})
