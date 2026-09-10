import { normalizeEvidenceHeader } from "./adapters";
import type { InstalledDiagnosticTool, ServerCapabilitySnapshot } from "./types";

export const CAPABILITY_ADAPTER_ID = "SQL_EVALUATE_CAPABILITIES_V1" as const;
export const CAPABILITY_STALE_DAYS = 30;

function text(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.toLowerCase() !== "null" ? normalized : null;
}

function numberValue(value: unknown): number | null {
  const normalized = text(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean | null {
  const normalized = text(value)?.toLowerCase();
  if (["1", "true", "yes", "on", "granted"].includes(normalized ?? "")) return true;
  if (["0", "false", "no", "off", "denied"].includes(normalized ?? "")) return false;
  return null;
}

function splitParameters(value: unknown): string[] {
  return (text(value) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizedFeature(value: unknown): ServerCapabilitySnapshot["lastQueryPlanStats"] {
  const normalized = text(value)?.toUpperCase();
  return normalized === "ON" || normalized === "OFF" || normalized === "UNAVAILABLE" ? normalized : "UNKNOWN";
}

export interface CapabilityParseResult {
  recognized: boolean;
  snapshot: ServerCapabilitySnapshot | null;
  error?: string;
  stale?: boolean;
}

export function parseCapabilitySnapshot(matrix: unknown[][], artifactId: string, now = new Date()): CapabilityParseResult {
  const header = matrix.slice(0, 50).map((row, index) => ({ index, headers: row.map(normalizeEvidenceHeader) }))
    .find(({ headers }) => headers.includes("adapter_id") && headers.includes("product_version"));
  if (!header) return { recognized: false, snapshot: null };
  const rows = matrix.slice(header.index + 1).filter((row) => row.some((value) => text(value)));
  const at = (row: unknown[], name: string) => row[header.headers.indexOf(name)];
  const capabilityRows = rows.filter((row) => text(at(row, "adapter_id"))?.toUpperCase() === CAPABILITY_ADAPTER_ID);
  if (!capabilityRows.length) return { recognized: false, snapshot: null };
  const first = capabilityRows[0];
  const productVersion = text(at(first, "product_version"));
  const capturedAtRaw = text(at(first, "captured_at"));
  const captured = capturedAtRaw ? new Date(capturedAtRaw) : null;
  if (!productVersion) return { recognized: true, snapshot: null, error: "The capability snapshot does not contain product_version." };
  if (!/^\d+(?:\.\d+){1,3}$/.test(productVersion)) return { recognized: true, snapshot: null, error: "The capability snapshot product_version is not a recognized SQL Server version." };
  if (!captured || Number.isNaN(captured.getTime())) return { recognized: true, snapshot: null, error: "The capability snapshot does not contain a valid captured_at timestamp." };
  const contextFields = ["captured_at", "server_name", "product_version", "edition", "engine_edition", "database_id", "database_name", "last_query_plan_stats", "query_store_state", "view_server_state", "view_server_performance_state", "view_database_state", "view_database_performance_state"];
  const contextValue = (row: unknown[], name: string) => (text(at(row, name)) ?? "").toLowerCase();
  if (capabilityRows.slice(1).some((row) => contextFields.some((name) => contextValue(row, name) !== contextValue(first, name)))) {
    return { recognized: true, snapshot: null, error: "The capability snapshot mixes rows from different capture, server, database, feature, or permission contexts." };
  }
  const warnings: string[] = [];
  const tools: InstalledDiagnosticTool[] = capabilityRows.flatMap((row) => {
    const toolId = text(at(row, "tool_id"));
    const objectName = text(at(row, "tool_name"));
    if (!toolId || !objectName) return [];
    return [{
      toolId,
      databaseName: text(at(row, "tool_database")),
      schemaName: text(at(row, "tool_schema")),
      objectName,
      installed: booleanValue(at(row, "installed")) === true,
      compatibleSignature: booleanValue(at(row, "compatible_signature")),
      version: text(at(row, "tool_version")),
      versionDate: text(at(row, "tool_version_date")),
      detectedParameters: splitParameters(at(row, "detected_parameters")),
    }];
  });
  if (!text(at(first, "edition"))) warnings.push("SQL Server edition was not visible to the snapshot login.");
  if (numberValue(at(first, "database_id")) === null && !text(at(first, "database_name"))) warnings.push("The affected database context was not present; database-scoped feature routing cannot be confirmed.");
  const permissions = {
    viewServerState: booleanValue(at(first, "view_server_state")),
    viewServerPerformanceState: booleanValue(at(first, "view_server_performance_state")),
    viewDatabaseState: booleanValue(at(first, "view_database_state")),
    viewDatabasePerformanceState: booleanValue(at(first, "view_database_performance_state")),
  };
  if (Object.values(permissions).every((value) => value !== true)) warnings.push("The snapshot did not confirm a supported performance-state permission.");
  const ageMs = now.getTime() - captured.getTime();
  const stale = ageMs > CAPABILITY_STALE_DAYS * 86_400_000;
  if (stale) warnings.push(`This capability snapshot is more than ${CAPABILITY_STALE_DAYS} days old; server settings or installed tools may have changed.`);
  const snapshot: ServerCapabilitySnapshot = {
    schemaVersion: "1.0",
    adapterId: CAPABILITY_ADAPTER_ID,
    capturedAt: captured.toISOString(),
    sourceArtifactId: artifactId,
    serverName: text(at(first, "server_name")),
    productVersion,
    productLevel: text(at(first, "product_level")),
    edition: text(at(first, "edition")),
    engineEdition: numberValue(at(first, "engine_edition")),
    databaseId: numberValue(at(first, "database_id")),
    databaseName: text(at(first, "database_name")),
    lastQueryPlanStats: normalizedFeature(at(first, "last_query_plan_stats")),
    queryStoreState: text(at(first, "query_store_state")),
    permissions,
    tools,
    warnings,
  };
  return { recognized: true, snapshot, stale };
}

export function sqlServerMajorVersion(snapshot: ServerCapabilitySnapshot | undefined): number | null {
  if (!snapshot) return null;
  const major = Number(snapshot.productVersion.split(".")[0]);
  return Number.isSafeInteger(major) ? major : null;
}

export function installedTool(snapshot: ServerCapabilitySnapshot | undefined, toolId: string): InstalledDiagnosticTool | undefined {
  return snapshot?.tools.find((tool) => tool.toolId === toolId && tool.installed);
}

export function capabilitySnapshotCommand(caseId = "UNASSIGNED"): string {
  const safeCaseId = caseId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "UNASSIGNED";
  return `/* SQL Evaluate server capability snapshot
   READ-ONLY DISCOVERY. Run in the affected database and save the single result grid as CSV or XLSX.
   SQL Evaluate never executes this script. Review @UtilityDatabase if community tools live elsewhere. */
SET NOCOUNT ON;
SET QUOTED_IDENTIFIER ON;
DECLARE @SqlEvaluateCase varchar(80) = '${safeCaseId}';
DECLARE @UtilityDatabase sysname; -- Change to master or your DBA utility database when needed.
SET @UtilityDatabase = DB_NAME();
DECLARE @AffectedDatabaseId int;
DECLARE @AffectedDatabaseName sysname;
SET @AffectedDatabaseId = DB_ID();
SET @AffectedDatabaseName = DB_NAME();
DECLARE @CapturedAt datetimeoffset = SYSDATETIMEOFFSET();
DECLARE @ProductVersion nvarchar(128) = CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion'));
DECLARE @MajorVersion int = TRY_CONVERT(int, LEFT(@ProductVersion, CHARINDEX('.', @ProductVersion + '.') - 1));
DECLARE @ProductLevel nvarchar(128) = CONVERT(nvarchar(128), SERVERPROPERTY('ProductLevel'));
DECLARE @Edition nvarchar(128) = CONVERT(nvarchar(128), SERVERPROPERTY('Edition'));
DECLARE @EngineEdition int = TRY_CONVERT(int, SERVERPROPERTY('EngineEdition'));
DECLARE @LastQueryPlanStats nvarchar(20) = COALESCE((SELECT TOP (1) CASE CONVERT(nvarchar(20), value) WHEN '1' THEN 'ON' WHEN '0' THEN 'OFF' ELSE UPPER(CONVERT(nvarchar(20), value)) END FROM sys.database_scoped_configurations WHERE name = 'LAST_QUERY_PLAN_STATS'), 'UNAVAILABLE');
DECLARE @ViewDatabaseState bit = HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DATABASE STATE');
DECLARE @ViewDatabasePerformanceState bit = CASE WHEN @MajorVersion >= 16 THEN HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DATABASE PERFORMANCE STATE') END;
DECLARE @QueryStoreState nvarchar(60) = 'PERMISSION_REQUIRED';
IF COALESCE(@ViewDatabaseState, 0) = 1 OR COALESCE(@ViewDatabasePerformanceState, 0) = 1
BEGIN
  BEGIN TRY
    SET @QueryStoreState = COALESCE((SELECT TOP (1) actual_state_desc FROM sys.database_query_store_options), 'UNAVAILABLE');
  END TRY
  BEGIN CATCH
    SET @QueryStoreState = 'ERROR';
  END CATCH;
END;

DECLARE @Discovery nvarchar(max) = N'USE ' + QUOTENAME(@UtilityDatabase) + N';
DECLARE @Tools table
(
  tool_id varchar(40) NOT NULL,
  tool_name sysname NOT NULL,
  object_type char(2) NOT NULL,
  required_parameter sysname NULL,
  installed bit NOT NULL DEFAULT 0,
  compatible_signature bit NULL,
  tool_schema sysname NULL,
  detected_parameters nvarchar(max) NULL,
  supports_version_check bit NOT NULL DEFAULT 0,
  tool_version varchar(30) NULL,
  tool_version_date datetime NULL
);
INSERT @Tools (tool_id, tool_name, object_type, required_parameter) VALUES
(''frk-blitz'', ''sp_Blitz'', ''P'', ''@CheckUserDatabaseObjects''),
(''frk-blitzfirst'', ''sp_BlitzFirst'', ''P'', ''@Seconds''),
(''frk-blitzwho'', ''sp_BlitzWho'', ''P'', ''@GetLiveQueryPlan''),
(''frk-blitzcache'', ''sp_BlitzCache'', ''P'', ''@OnlySqlHandles''),
(''frk-blitzindex'', ''sp_BlitzIndex'', ''P'', ''@DatabaseName''),
(''frk-blitzlock'', ''sp_BlitzLock'', ''P'', ''@VictimsOnly''),
(''frk-blitzanalysis'', ''sp_BlitzAnalysis'', ''P'', ''@OutputTableNameBlitzFirst''),
(''whoisactive'', ''sp_WhoIsActive'', ''P'', ''@get_plans''),
(''ola-databasebackup'', ''DatabaseBackup'', ''P'', ''@Databases''),
(''ola-integritycheck'', ''DatabaseIntegrityCheck'', ''P'', ''@Databases''),
(''ola-indexoptimize'', ''IndexOptimize'', ''P'', ''@Databases''),
(''ola-commandlog'', ''CommandLog'', ''U'', NULL);

UPDATE t
SET installed = 1,
    tool_schema = found.tool_schema,
    compatible_signature = CASE WHEN t.required_parameter IS NULL OR EXISTS (SELECT 1 FROM sys.parameters AS rp WHERE rp.object_id = found.object_id AND rp.name COLLATE DATABASE_DEFAULT = t.required_parameter COLLATE DATABASE_DEFAULT) THEN 1 ELSE 0 END,
    supports_version_check = CASE WHEN t.object_type = ''P''
      AND EXISTS (SELECT 1 FROM sys.parameters AS vp WHERE vp.object_id = found.object_id AND vp.name COLLATE DATABASE_DEFAULT = ''@Version'')
      AND EXISTS (SELECT 1 FROM sys.parameters AS vp WHERE vp.object_id = found.object_id AND vp.name COLLATE DATABASE_DEFAULT = ''@VersionDate'')
      AND EXISTS (SELECT 1 FROM sys.parameters AS vp WHERE vp.object_id = found.object_id AND vp.name COLLATE DATABASE_DEFAULT = ''@VersionCheckMode'')
      THEN 1 ELSE 0 END,
    detected_parameters = STUFF((SELECT '','' + p.name FROM sys.parameters AS p WHERE p.object_id = found.object_id ORDER BY p.parameter_id FOR XML PATH(''''), TYPE).value(''.'', ''nvarchar(max)''), 1, 1, '''')
FROM @Tools AS t
OUTER APPLY
(
  SELECT TOP (1) o.object_id, s.name AS tool_schema
  FROM sys.objects AS o
  JOIN sys.schemas AS s ON s.schema_id = o.schema_id
  WHERE o.name COLLATE DATABASE_DEFAULT = t.tool_name COLLATE DATABASE_DEFAULT
    AND o.type COLLATE DATABASE_DEFAULT = t.object_type COLLATE DATABASE_DEFAULT
  ORDER BY CASE WHEN s.name COLLATE DATABASE_DEFAULT = ''dbo'' THEN 0 ELSE 1 END, s.name, o.object_id
) AS found
WHERE found.object_id IS NOT NULL;

DECLARE @ToolId varchar(40), @ToolName sysname, @ToolSchema sysname, @Command nvarchar(max), @Version varchar(30), @VersionDate datetime;
DECLARE version_cursor CURSOR LOCAL FAST_FORWARD FOR SELECT tool_id, tool_name, tool_schema FROM @Tools WHERE supports_version_check = 1;
OPEN version_cursor;
FETCH NEXT FROM version_cursor INTO @ToolId, @ToolName, @ToolSchema;
WHILE @@FETCH_STATUS = 0
BEGIN
  BEGIN TRY
    SET @Version = NULL; SET @VersionDate = NULL;
    SET @Command = N''EXEC '' + QUOTENAME(@ToolSchema) + N''.'' + QUOTENAME(@ToolName) + N'' @Version=@v OUTPUT, @VersionDate=@d OUTPUT, @VersionCheckMode=1;'';
    EXEC sys.sp_executesql @Command, N''@v varchar(30) OUTPUT, @d datetime OUTPUT'', @v=@Version OUTPUT, @d=@VersionDate OUTPUT;
    UPDATE @Tools SET tool_version = @Version, tool_version_date = @VersionDate WHERE tool_id = @ToolId;
  END TRY
  BEGIN CATCH
    UPDATE @Tools SET compatible_signature = 0 WHERE tool_id = @ToolId;
  END CATCH;
  FETCH NEXT FROM version_cursor INTO @ToolId, @ToolName, @ToolSchema;
END;
CLOSE version_cursor; DEALLOCATE version_cursor;

SELECT
  ''SQL_EVALUATE_CAPABILITIES_V1'' AS adapter_id,
  ''1.0'' AS schema_version,
  @CaseId AS case_id,
  @Captured AS captured_at,
  CONVERT(nvarchar(128), SERVERPROPERTY(''ServerName'')) AS server_name,
  @VersionNumber AS product_version,
  @Level AS product_level,
  @EditionName AS edition,
  @Engine AS engine_edition,
  @AffectedDatabaseId AS database_id,
  @AffectedDatabaseName AS database_name,
  @Lqps AS last_query_plan_stats,
  @QueryStore AS query_store_state,
  HAS_PERMS_BY_NAME(NULL, NULL, ''VIEW SERVER STATE'') AS view_server_state,
  HAS_PERMS_BY_NAME(NULL, NULL, ''VIEW SERVER PERFORMANCE STATE'') AS view_server_performance_state,
  @ViewDbState AS view_database_state,
  @ViewDbPerformanceState AS view_database_performance_state,
  t.tool_id,
  DB_NAME() AS tool_database,
  t.tool_schema,
  t.tool_name,
  t.installed,
  t.compatible_signature,
  t.tool_version,
  CONVERT(varchar(30), t.tool_version_date, 126) AS tool_version_date,
  t.detected_parameters
FROM @Tools AS t
ORDER BY t.tool_id;';

EXEC sys.sp_executesql @Discovery,
  N'@CaseId varchar(80), @Captured datetimeoffset, @VersionNumber nvarchar(128), @Level nvarchar(128), @EditionName nvarchar(128), @Engine int, @AffectedDatabaseId int, @AffectedDatabaseName sysname, @Lqps nvarchar(20), @QueryStore nvarchar(60), @ViewDbState bit, @ViewDbPerformanceState bit',
  @CaseId=@SqlEvaluateCase, @Captured=@CapturedAt, @VersionNumber=@ProductVersion, @Level=@ProductLevel,
  @EditionName=@Edition, @Engine=@EngineEdition, @AffectedDatabaseId=@AffectedDatabaseId, @AffectedDatabaseName=@AffectedDatabaseName,
  @Lqps=@LastQueryPlanStats, @QueryStore=@QueryStoreState,
  @ViewDbState=@ViewDatabaseState, @ViewDbPerformanceState=@ViewDatabasePerformanceState;`;
}
