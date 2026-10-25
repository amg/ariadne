import {
  type CompiledQuery,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  PostgresDialect,
  PostgresQueryCompiler,
  type QueryCompiler,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';

const TAG_NAME = /^[A-Za-z0-9_/]+$/;

/** Weakly held, because a query that is compiled but never run must not pin its name. */
const tagNames = new WeakMap<QueryId, string>();

/**
 * Names every query run through the handle it is added to, as
 * `<queries folder>/<file>` (`messageSideCosts/addSideCost`). The name
 * leads the statement's SQL as a comment, so database statistics that
 * keep the statement text show which query file sent it.
 */
export function tagQuery(name: string) {
  if (!TAG_NAME.test(name)) throw new Error(`tagQuery: "${name}" is not a query file name`);
  return {
    transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
      tagNames.set(queryId, name);
      return node;
    },
    async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return result;
    },
  };
}

class TaggingQueryCompiler extends PostgresQueryCompiler {
  override compileQuery(node: RootOperationNode, queryId: QueryId): CompiledQuery {
    const compiled = super.compileQuery(node, queryId);
    const name = tagNames.get(queryId);
    return name === undefined
      ? compiled
      : { ...compiled, sql: `/* query:${name} */ ${compiled.sql}` };
  }
}

/** The Postgres dialect, writing each tagged query's name ahead of its SQL. */
export class TaggingPostgresDialect extends PostgresDialect {
  override createQueryCompiler(): QueryCompiler {
    return new TaggingQueryCompiler();
  }
}
