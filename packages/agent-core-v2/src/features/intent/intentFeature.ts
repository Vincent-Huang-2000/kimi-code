import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IFlagService } from '#/app/flag/flag';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { INTENT_ENGINE_FLAG } from './flag';
import { AgentIntentService, IIntentService } from './intentService';
import { IIntentTool, IntentTool, IIntentInvestigateTool, IntentInvestigateTool } from './intentTools';
import './configSection';

function available(accessor: ServicesAccessor): boolean {
  return accessor.get(IFlagService).enabled(INTENT_ENGINE_FLAG) && accessor.get(IAgentScopeContext).agentId === MAIN_AGENT_ID;
}

export class IntentFeature extends Feature {
  static override readonly name = 'intent';
  constructor() {
    super();
    this.contributeAgentService(IIntentService, AgentIntentService);
    this.contributeTool(IIntentTool, IntentTool, { name: 'Intent', domain: 'intent', when: available });
    this.contributeTool(IIntentInvestigateTool, IntentInvestigateTool, { name: 'IntentInvestigate', domain: 'intent', when: available });
    this.contributeCommand({ name: 'deep', description: 'Analyze the current task before implementation', when: available,
      run: (context) => context.get(IIntentService).command(context.args) });
  }
}
registerFeature(IntentFeature);
