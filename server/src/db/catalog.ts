import type { Client } from 'pg';

export type Catalog = Record<string, unknown[]>;

// Compare logical definitions, not physical OIDs, row data, column order, or
// sequence counters. Ignore only Prisma's own bookkeeping and extension members.
export async function readCatalog(client: Client): Promise<Catalog> {
  await client.query('SET search_path TO public, pg_catalog');
  const result: Catalog = {};
  const queries: Record<string, string> = {
    relations: `SELECT c.relname AS name, c.relkind AS kind,
      c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
      CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')
      AND c.relname <> '_prisma_migrations'
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
        AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relname`,
    columns: `SELECT c.relname AS table_name, a.attname AS name,
      format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
      pg_get_expr(d.adbin,d.adrelid) AS default_value,
      a.attidentity AS identity, a.attgenerated AS generated,
      CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS collation
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND c.relname <> '_prisma_migrations' AND a.attnum>0 AND NOT a.attisdropped
      AND NOT EXISTS(SELECT 1 FROM pg_depend e WHERE e.classid='pg_class'::regclass
        AND e.objid=c.oid AND e.deptype='e') ORDER BY c.relname,a.attname`,
    constraints: `SELECT c.relname AS table_name, co.conname AS name,
      co.contype AS type, pg_get_constraintdef(co.oid,true) AS definition,
      co.convalidated AS validated
      FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname <> '_prisma_migrations'
      AND NOT EXISTS(SELECT 1 FROM pg_depend e WHERE e.classid='pg_class'::regclass
        AND e.objid=c.oid AND e.deptype='e') ORDER BY c.relname,co.conname`,
    indexes: `SELECT t.relname AS table_name, c.relname AS name,
      pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid,
      i.indisready AS ready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname <> '_prisma_migrations'
      AND NOT EXISTS(SELECT 1 FROM pg_depend e WHERE e.classid='pg_class'::regclass
        AND e.objid=t.oid AND e.deptype='e') ORDER BY t.relname,c.relname`,
    sequences: `SELECT c.relname AS name, format_type(s.seqtypid,NULL) AS type,
      s.seqstart::text AS start, s.seqincrement::text AS increment,
      s.seqmax::text AS maximum, s.seqmin::text AS minimum,
      s.seqcache::text AS cache, s.seqcycle AS cycle,
      t.relname AS owned_table, a.attname AS owned_column
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i')
      LEFT JOIN pg_class t ON t.oid=d.refobjid
      LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE n.nspname='public' ORDER BY c.relname`,
    extensions: `SELECT e.extname AS name, n.nspname AS schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
      WHERE e.extname <> 'plpgsql' ORDER BY e.extname`,
    functions: `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_functiondef(p.oid) AS definition FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
        AND d.objid=p.oid AND d.deptype='e') ORDER BY p.proname,arguments`,
    triggers: `SELECT c.relname AS table_name, t.tgname AS name,
      pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    policies: `SELECT tablename AS table_name, policyname AS name,
      permissive, roles, cmd, qual, with_check FROM pg_policies
      WHERE schemaname='public' ORDER BY tablename,policyname`,
    enums: `SELECT t.typname AS name, e.enumlabel AS value, e.enumsortorder AS position
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public'
      ORDER BY t.typname,e.enumsortorder`,
    types: `SELECT t.typname AS name, t.typtype AS kind,
      CASE WHEN t.typbasetype <> 0 THEN format_type(t.typbasetype,t.typtypmod) END AS base_type,
      t.typnotnull AS not_null, t.typdefault AS default_value,
      (SELECT jsonb_agg(pg_get_constraintdef(c.oid,true) ORDER BY c.conname)
        FROM pg_constraint c WHERE c.contypid=t.oid) AS constraints
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public' AND t.typrelid=0 AND t.typcategory <> 'A' AND t.typtype <> 'e'
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass
        AND d.objid=t.oid AND d.deptype='e') ORDER BY t.typname`,
    aggregates: `SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS arguments
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind='a'
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
        AND d.objid=p.oid AND d.deptype='e') ORDER BY p.proname,arguments`,
  };
  for (const [name, sql] of Object.entries(queries)) result[name] = (await client.query(sql)).rows;
  return result;
}

export function catalogDifference(actual: Catalog, expected: Catalog): string | undefined {
  for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (JSON.stringify(actual[name]) !== JSON.stringify(expected[name])) {
      const observed = actual[name] ?? [];
      const wanted = expected[name] ?? [];
      const changed = observed.find((row, i) => JSON.stringify(row) !== JSON.stringify(wanted[i])) ?? wanted[observed.length];
      return `${name} differ near ${JSON.stringify(changed)}`;
    }
  }
  return undefined;
}
