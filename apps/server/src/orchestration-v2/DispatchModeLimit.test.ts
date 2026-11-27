import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-mode-limit" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:dispatch-mode-limit"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      ...supervised,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("DispatchModeLimit", (it) => {
  it.effect("runs a limited command on a thread its user raised", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:limit-raised");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise"),
        threadId,
        runtimeMode: "full-access",
      });
      const rename = {
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "After",
      } as const;
      // t3purge: a caller's limit never refuses a dispatch.
      yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised));
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("forks a source thread its user raised", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sourceThreadId = ThreadId.make("thread:limit-fork-source");
      const targetThreadId = ThreadId.make("thread:limit-fork-target");
      yield* createThread(sourceThreadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-source"),
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      const fork = {
        type: "thread.fork",
        commandId: CommandId.make("fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      // t3purge: a caller's limit never refuses a dispatch; the fork reaches
      // ordinary validation and fails only for want of a stable source run.
      const outcome = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(outcome._tag, "OrchestratorDispatchError");
      assert.isNull(yield* projections.getThreadShell(targetThreadId));
    }),
  );
});

const layerPolicyDatabase = SqlitePersistence.layerMemory;
const layerWithCeiling = Layer.mergeAll(
  layerPolicyDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerPolicyDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "runtime-mode-ceiling" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerPolicyDatabase,
      runEffectWorker: false,
      managedPolicy: {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { maxRuntimeMode: "auto-accept-edits" },
      },
    },
  ),
);

const sendMessage = (threadId: ThreadId, id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

/** A thread that ran in full access before the policy arrived, as an import or an older build leaves it. */
const raiseBehindPolicy = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* createThread(threadId);
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:raise-behind-policy:${threadId}`),
          type: "thread.runtime-mode-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...thread, runtimeMode: "full-access" },
        },
      ],
    });
  });

it.layer(layerWithCeiling)("runtime mode ceiling", (it) => {
  it.effect("runs the user's own thread and mode changes above the ceiling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-user");
      // t3purge: a managed runtime-mode ceiling refuses nothing.
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:ceiling-user:full"),
        threadId,
        projectId: ProjectId.make("project:dispatch-mode-limit"),
        title: "Full",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.runtimeMode, "full-access");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise:ceiling-user"),
        threadId,
        runtimeMode: "auto",
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.runtimeMode, "auto");
    }),
  );

  it.effect("keeps an MCP caller's limit as sent above the ceiling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-mcp");
      yield* createThread(threadId);
      const fullAccessCaller = { runtimeMode: "full-access", interactionMode: "default" } as const;
      // t3purge: a managed runtime-mode ceiling refuses nothing.
      yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:ceiling-mcp"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller));
      assert.equal((yield* projections.getThreadShell(threadId))?.runtimeMode, "full-access");

      const raisedThreadId = ThreadId.make("thread:ceiling-mcp-raised");
      yield* raiseBehindPolicy(raisedThreadId);
      yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename:ceiling-mcp"),
          threadId: raisedThreadId,
          title: "After",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller));
      assert.equal((yield* projections.getThreadShell(raisedThreadId))?.title, "After");
    }),
  );

  it.effect("runs turns on a thread above the ceiling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-raised");
      yield* raiseBehindPolicy(threadId);

      // t3purge: a managed runtime-mode ceiling refuses nothing.
      yield* orchestrator.dispatch(sendMessage(threadId, "first"));
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 1);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename:ceiling-raised"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-raised"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch(sendMessage(threadId, "second"));
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 2);
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("starts a queue that waited above the ceiling once the mode is lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:ceiling-queue");
      yield* createThread(threadId);
      yield* orchestrator.dispatch(sendMessage(threadId, "running"));
      yield* orchestrator.dispatch({
        ...sendMessage(threadId, "waiting"),
        dispatchMode: { type: "queue_after_active" },
      });
      // The policy arrives with the thread above it and its first run ending.
      const { thread, runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const [running, waiting] = runs;
      const occurredAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:ceiling-queue:raise"),
            type: "thread.runtime-mode-updated",
            threadId,
            occurredAt,
            payload: { ...thread, runtimeMode: "full-access" },
          },
          {
            id: EventId.make("event:ceiling-queue:complete"),
            type: "run.updated",
            threadId,
            runId: running!.id,
            providerInstanceId: running!.providerInstanceId,
            occurredAt,
            payload: { ...running!, status: "completed" },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-queue"),
        threadId,
        runtimeMode: "approval-required",
      });
      const started = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id === waiting!.id,
      );
      assert.notEqual(started?.status, "queued");
    }),
  );
});
