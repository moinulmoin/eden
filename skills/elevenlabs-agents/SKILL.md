---
name: "elevenlabs-agents"
description: "Build, configure and manage Conversational AI agents, knowledge bases, tools, and conversations."
---

# agents

> **PREREQUISITE:** Read `../elevenlabs-shared/SKILL.md` for auth, global flags, and output formatting. If missing, run `elevenlabs generate-skills` to create it.

```bash
elevenlabs agents <method> [flags]
```

## API Resources

 - `add_to_knowledge_base` — Add To Knowledge Base
 - `create` — Create agent
 - `delete` — Delete agent
 - `delete_document_rag_index` — Delete Rag Index.
 - `duplicate` — Duplicate Agent
 - `get` — Get agent
 - `get_document_rag_indexes` — Get Rag Indexes Of The Specified Knowledgebase Document.
 - `list` — List Agents
 - `rag_index_overview` — Get Rag Index Overview.
 - `run_tests` — Run Tests On The Agent
 - `simulate_conversation` — Simulates A Conversation
 - `simulate_conversation_stream` — Simulates A Conversation (Stream)
 - `update` — Update agent

### agents


#### llm-usage

 - `calculate` — Calculate Expected Llm Usage For An Agent

### analytics


#### live-count

 - `get` — Get Live Count

### batch-calls

 - `cancel` — Cancel A Batch Call.
 - `create` — Submit A Batch Call Request.
 - `delete` — Delete A Batch Call.
 - `export` — Export Batch Call Results
 - `get` — Get A Batch Call By Id.
 - `list` — Get All Batch Calls For A Workspace.
 - `retry` — Retry A Batch Call.

### branches

 - `create` — Create A New Branch
 - `get` — Get Agent Branch
 - `list` — List Agent Branches
 - `merge` — Merge A Branch Into A Target Branch
 - `preview_merge` — Preview Merged Configuration
 - `preview_rebase` — Preview Rebased Configuration
 - `rebase` — Rebase A Branch Onto Main
 - `update` — Update Agent Branch

### conversations

 - `delete` — Delete Conversation
 - `get` — Get Conversation Details
 - `get_signed_url` — Get Signed Url
 - `get_sip_messages` — Get Sip Messages For A Conversation
 - `get_summary` — Get Conversation Summary
 - `get_webrtc_token` — Get a webrtc token to start a conversation with an agent that requires authorization
 - `list` — List conversations
 - `resolve` — Resolve Conversation Reference

#### analysis

 - `run` — Run Conversation Analysis
 - `runEvaluation` — Run Conversation Evaluation

#### audio

 - `get` — Get Conversation Audio

#### feedback

 - `create` — Send Conversation Feedback

#### files

 - `create` — Upload File
 - `delete` — Delete File Upload

#### messages

 - `search` — Smart Search Conversation Messages
 - `text_search` — Text Search Conversation Messages

#### tags

 - `assign` — Assign Conversation Tags
 - `create` — Create Conversation Tag
 - `delete` — Delete Conversation Tag
 - `get` — Get Conversation Tag
 - `list` — List Conversation Tags
 - `unassign` — Unassign Conversation Tag
 - `update` — Update Conversation Tag

#### topics

 - `get` — Get Agent Conversation Topics

### dashboard


#### settings

 - `get` — Get Convai Dashboard Settings
 - `update` — Update Convai Dashboard Settings

### deployments

 - `create` — Create Or Update Deployments

### drafts

 - `create` — Create Agent Draft
 - `delete` — Delete Agent Draft

### exotel

 - `outbound_call` — Handle An Outbound Call Via Exotel

### hold-audio

 - `create` — Post Agent Hold Audio
 - `delete` — Delete Agent Hold Audio

### knowledge-base

 - `get_or_create_rag_indexes` — Compute Rag Indexes In Batch
 - `list` — Get Knowledge Base List
 - `search` — Search Knowledge Base Content
 - `size` — Returns The Size Of The Agent'S Knowledge Base

#### crawl-jobs

 - `cancel` — Cancel Crawl Job
 - `create` — Create Crawl Job
 - `get` — Get Crawl Job Details
 - `list` — List Ongoing And Recent Crawl Jobs Created By A User

#### document

 - `compute_rag_index` — Compute Rag Index.
 - `refresh` — Refresh Url Document Content
 - `update_file` — Update File Document

#### documents

 - `bulk_delete` — Bulk Delete Knowledge Base Documents
 - `bulk_move` — Bulk Move Entities To Folder
 - `create_folder` — Create Folder
 - `create_from_file` — Create File Document
 - `create_from_text` — Create Text Document
 - `create_from_url` — Create Url Document
 - `delete` — Delete Knowledge Base Document Or Folder
 - `get` — Get Documentation From Knowledge Base
 - `get_agents` — Get Dependent Agents List
 - `get_bulk_agents` — Get Dependent Agents For Multiple Documents
 - `get_content` — Get Document Content
 - `get_source_file_url` — Get Document Source File Url
 - `move` — Move Entity To Folder
 - `update` — Update Document

##### chunk

 - `get` — Get Documentation Chunk From Knowledge Base

##### chunks

 - `list` — Get All Rag Chunks For A Document

##### summaries

 - `get` — Get Knowledge Base Summaries By Ids

### link

 - `get` — Get Shareable Agent Link

### llm

 - `list` — List Available Llms

### llm-usage

 - `calculate` — Calculate Expected Llm Usage

### mcp-servers

 - `create` — Create Mcp Server
 - `delete` — Delete Mcp Server
 - `get` — Get Mcp Server
 - `list` — List Mcp Servers
 - `update` — Update Mcp Server Configuration

#### approval-policy

 - `update` — Update Mcp Server Approval Policy

#### tool-approvals

 - `create` — Create Mcp Server Tool Approval
 - `delete` — Delete Mcp Server Tool Approval

#### tool-configs

 - `create` — Create Mcp Tool Configuration Override
 - `delete` — Delete Mcp Tool Configuration Override
 - `get` — Get Mcp Tool Configuration Override
 - `update` — Update Mcp Tool Configuration Override

#### tools

 - `list` — List Mcp Server Tools

### phone-numbers

 - `create` — Import Phone Number
 - `delete` — Delete Phone Number
 - `get` — Get Phone Number
 - `get_sip_messages` — Get Sip Messages For A Phone Number
 - `list` — List Phone Numbers
 - `list_v2` — List Phone Numbers Page
 - `update` — Update Phone Number

### procedures

 - `compile` — Compile Procedures
 - `create` — Create Procedure
 - `get` — Get Procedure
 - `list` — List Procedures
 - `remove` — Remove Procedure

#### drafts

 - `delete` — Delete Procedure Draft
 - `get` — Get Procedure Draft
 - `update` — Update Procedure Draft

### secrets

 - `create` — Create Convai Workspace Secret
 - `delete` — Delete Convai Workspace Secret
 - `get` — Get Convai Workspace Secret
 - `get_dependencies` — Get Secret Dependencies By Type
 - `list` — Get Convai Workspace Secrets
 - `update` — Update Convai Workspace Secret

### settings

 - `get` — Get Convai Settings
 - `update` — Update Convai Settings

### sip-trunk

 - `outbound_call` — Handle An Outbound Call Via Sip Trunk

### summaries

 - `get` — Get Agent Summaries

### tests

 - `create` — Create Agent Response Test
 - `delete` — Delete Agent Response Test
 - `get` — Get Agent Response Test By Id
 - `list` — List Agent Response Tests
 - `move` — Bulk Move Tests To Folder
 - `summaries` — Get Agent Response Test Summaries By Ids
 - `update` — Update Agent Response Test

#### folders

 - `create` — Create Agent Test Folder
 - `delete` — Delete Agent Test Folder
 - `get` — Get Agent Test Folder By Id
 - `update` — Update Agent Test Folder

#### invocations

 - `get` — Get Test Invocation
 - `list` — List Test Invocations
 - `resubmit` — Resubmit Tests

### tools

 - `create` — Add Tool
 - `delete` — Delete Tool
 - `get` — Get Tool
 - `get_dependent_agents` — Get Dependent Agents List
 - `list` — Get Tools
 - `update` — Update Tool

#### executions

 - `get` — Get Tool Executions

### triage-tickets

 - `add_comment` — Add Comment To Agent Conversation Ticket
 - `add_turn_comment` — Add Turn Comment To Agent Conversation Ticket
 - `create` — Create Agent Conversation Ticket
 - `create_manual` — Create Manual Agent Ticket
 - `delete` — Delete Agent Conversation Ticket
 - `get` — Get Agent Conversation Ticket
 - `list` — List Agent Conversation Tickets
 - `list_assignable_users` — Get Agent Conversation Ticket Assignable Users
 - `list_for_workspace` — List Workspace Conversation Tickets
 - `update` — Update Agent Conversation Ticket

### twilio

 - `outbound_call` — Handle An Outbound Call Via Twilio
 - `register_call` — Register A Twilio Call And Return Twiml

### users

 - `list` — Get Conversation Users

### versions

 - `get` — Get Agent Version Metadata

### whatsapp

 - `outbound_call` — Make An Outbound Call Via Whatsapp
 - `outbound_message` — Send An Outbound Message Via Whatsapp

### whatsapp-accounts

 - `delete` — Delete Whatsapp Account
 - `get` — Get Whatsapp Account
 - `list` — List Whatsapp Accounts
 - `update` — Update Whatsapp Account

### widget

 - `get` — Get Agent Widget Config

#### avatar

 - `create` — Post Agent Avatar
## Discovering Commands

**Agents: always prefer `--schema` over `--help`** — `--schema` returns JSON; `--help` returns human prose.

```bash
# Machine-readable surface (use this)
elevenlabs agents --schema
elevenlabs agents <method> --schema

# Human-readable help (for humans)
elevenlabs agents --help
```


## Nothing here fits?

`--schema` and `--help` list only what exists. If the user's request cannot be done
with any command, report the gap — it is how missing commands get built:

```bash
elevenlabs feedback missing-capability "<what you needed>"
```
