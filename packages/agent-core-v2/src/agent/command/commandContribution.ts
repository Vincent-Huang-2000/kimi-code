import { collection } from '#/_base/di/collection';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';

export interface CommandRunContext {
  readonly args: string;
  get<T>(id: ServiceIdentifier<T>): T;
}

export interface CommandContribution {
  readonly name: string;
  readonly description?: string;
  readonly when?: (accessor: ServicesAccessor) => boolean;
  readonly run: (ctx: CommandRunContext) => void | Promise<void>;
}

export const CommandContribution = collection<CommandContribution>('command');
