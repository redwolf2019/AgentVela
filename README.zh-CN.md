<div align="center">

# AgentVela

**开源、跨平台的 AI Coding Agent 控制中心。**

通过统一且高性能的界面，在本地与远程机器上运行、编排并管理多个 AI 编程智能体。

[English](./README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Issues](https://img.shields.io/github/issues/redwolf2019/AgentVela)](https://github.com/redwolf2019/AgentVela/issues)

</div>

## 项目简介

AgentVela 通过统一的 Node WebSocket 控制平面驱动本地与远程的各类 AI Coding Agent，并提供桌面端、Web 端与移动端一致的操作体验。你可以在电脑前发起任务、在同一个会话中随时切换模型或 Agent、在独立的 Git Worktree 中审查代码变更，并在其他设备或手机上继续协作。

当前支持 **Claude Code**、**Codex**、**Cursor**、**OpenCode**、**Grok Build**、**Antigravity**、**Kiro**、**Pi**、**Muse Code**、**fx**，以及任意兼容 [ACP（Agent Client Protocol）](./docs/user/providers-acp.md) 的智能体。

## 核心特性

- **自带订阅，不转售 Token。** 直接复用你本机已登录的 Agent CLI 与账号订阅，无额外加价。
- **多 Agent 统一工作台。** 在同一界面管理多个编程智能体，支持会话中途切换模型以及跨 Agent 交接任务。
- **多端协同架构。** 单一服务端驱动 Desktop（Electron）、Web（React/Vite）与 Mobile（React Native），多端状态实时同步。
- **自托管与远程就绪。** 可在任意主机运行 Agent，通过局域网、SSH、Tailscale 或自建中继远程接入。
- **内置 Git 工作流。** 每个会话支持独立 Git Worktree，界面内即可查看 Diff、提交、推送并创建 Pull Request。
- **开放扩展（ACP & MCP）。** 原生支持接入任意 ACP Agent，并可通过 MCP 与外部智能体及工具协同。
- **极致性能导向。** 注重低延迟流式传输、受控的通信负载与流畅的界面渲染。

## 项目状态与路线图

AgentVela 目前处于独立演进初期，现阶段支持从源码构建与运行，同时正在逐步完善项目自身的品牌体系与发布流程。

近期规划：

- **专属品牌与文档**：推出 AgentVela 专属图标、视觉设计与持续更新的完整文档体系。
- **独立构建与分发**：通过 GitHub Releases 提供 macOS / Windows / Linux 桌面安装包及独立 CLI 分发。
- **自托管优先**：打造无专有云服务绑定的自托管远程连接与多机协作体验。
- **多 Agent 编排增强**：围绕 AgentVela 的产品方向，深化工作流自动化与多智能体协作能力。

## 快速开始（从源码运行）

目前尚未发布预编译安装包，你可以直接从源码在本地构建并运行 AgentVela。

### 1. 环境准备

安装 [Vite+](https://viteplus.dev/guide/)（`vp` 会自动管理 `package.json` 中锁定的 Node.js 工具链）：

```bash
curl -fsSL https://vite.plus | bash
```

Windows（PowerShell）：

```powershell
irm https://vite.plus/ps1 | iex
```

同时需要本机至少安装并登录一个编程 Agent CLI，例如 [Claude Code](https://claude.com/product/claude-code)（`claude auth login`）或 [Codex CLI](https://developers.openai.com/codex/cli)（`codex login`）。

### 2. 克隆仓库并安装依赖

```bash
git clone https://github.com/redwolf2019/AgentVela.git
cd AgentVela
vp i
```

> Windows 用户建议使用 `git clone -c core.longpaths=true https://github.com/redwolf2019/AgentVela.git` 以避免长路径问题。

### 3. 本地开发运行

启动本地服务端与 Web 界面：

```bash
vp run dev
```

启动后，打开终端输出的配对链接（pairing URL）即可完成浏览器鉴权并进入界面。

其他常用启动方式：

- **桌面端（Electron）**：`vp run dev:desktop`
- **通过 Tailscale 远程共享**：`vp run dev --share`
- **自建公网中继**：在 Linux 服务器部署 [`apps/relay`](./apps/relay)，本地主机执行 `t3 relay link` 即可加密回连管理，详见 [自建中继部署手册](./docs/operations/02_connect-setup.md)
- **移动端（React Native）**：参考 [apps/mobile/README.md](./apps/mobile/README.md)

### 4. 本地打包桌面安装包（可选）

生成的未签名本地安装包位于 `release/` 目录：

```bash
vp run dist:desktop:dmg    # macOS
vp run dist:desktop:linux  # Linux AppImage
vp run dist:desktop:win    # Windows NSIS
```

各平台打包前置依赖与进阶说明请参考 [开发手册](./docs/operations/00_development.md)。

## 文档导航

> `docs/` 目录下部分参考文档仍在逐步按 AgentVela 的实际演进更新中。

- [开发与本地构建手册](./docs/operations/00_development.md)
- [架构总览](./docs/internals/01_architecture.md)
- [ACP Agent 接入说明](./docs/user/providers-acp.md)
- [权限模式说明](./docs/user/permission-modes.md)
- [源码管理与 Git Worktree](./docs/user/source-control.md)
- [远程访问指南](./docs/user/remote-access.md)
- [自建中继部署手册](./docs/operations/02_connect-setup.md)
- [外部 Agent 接入（MCP）](./docs/user/outside-agents.md)
- [全部文档目录](./docs/README.md)

## 参与贡献

欢迎提交 Issue、建议和 Pull Request：

- 提交代码前，请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，了解贡献规范、PR 范围与验证要求。
- 问题反馈与功能建议请前往 [GitHub Issues](https://github.com/redwolf2019/AgentVela/issues)。
- 提交代码前，请先参考 [开发手册](./docs/operations/00_development.md) 完成环境配置，并运行 `vp run check:changed` 确保检查通过。

## 开源协议

本仓库源代码基于 [MIT License](./LICENSE) 开源。

## 致谢

AgentVela 由本项目独立维护，并会根据需要偶尔同步部分上游改进。项目最初基于 MIT 开源协议的 [T3 Code](https://github.com/pingdotgg/t3code) 代码库演进而来。
