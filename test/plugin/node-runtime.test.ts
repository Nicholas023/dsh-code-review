// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 dsh-code-review contributors

/**
 * node-runtime.test.ts —— 进程启动方式的一致性。
 *
 * 这个测试守护的是一个**只会在实机出现**的故障：
 * 插件跑在 DSH 的 Electron 进程里，process.execPath 是 Harness.exe。
 * 直接拿它跑 kernel/main.js 会开一个新窗口而不是执行脚本 ——
 * 症状是「点了评审，什么也没发生」。
 *
 * 单测里我们跑的是真 node，所以测不到那个失败本身；
 * 能测的是「启动环境里确实带了 Electron 的 Node 模式开关」，
 * 以及这个开关不会被 runner 的 env 白名单吃掉。
 */

import { describe, expect, it } from 'vitest'
import { ELECTRON_NODE_FLAG, nodeLaunchEnv } from '../../src/plugin/node-runtime.js'
import { runnerEnv } from '../../src/ptc/runner-client.js'

describe('Node 启动环境', () => {
  it('开关常量是 Electron 认识的变量名', () => {
    expect(ELECTRON_NODE_FLAG).toBe('ELECTRON_RUN_AS_NODE')
  })

  it('nodeLaunchEnv 一定带上开关且值为 1', () => {
    expect(nodeLaunchEnv({}).ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('基于父环境构造时保留原有变量', () => {
    const env = nodeLaunchEnv({ PATH: '/usr/bin', FOO: 'bar' })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.FOO).toBe('bar')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('不修改传入的环境对象（纯函数）', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    nodeLaunchEnv(base)
    expect(base.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('默认以 process.env 为基底', () => {
    const env = nodeLaunchEnv()
    // PATH 应被继承（真 node 与 Electron 都需要它定位系统库）
    expect(typeof env.PATH === 'string' || typeof env.Path === 'string').toBe(true)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('runner 白名单保留启动开关', () => {
  it('父进程带该变量时，runner 也能拿到', () => {
    const original = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      // 关键：如果白名单漏了它，runner 在 Electron 宿主下会以「再开一个窗口」的方式启动
      expect(runnerEnv().ELECTRON_RUN_AS_NODE).toBe('1')
    } finally {
      if (original === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = original
    }
  })

  it('该开关不在「形似凭据」的排除范围内（它必须被保留）', () => {
    expect('ELECTRON_RUN_AS_NODE').not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i)
  })
})
