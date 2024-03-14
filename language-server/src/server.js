// Language Server
import {
  createConnection,
  DiagnosticSeverity,
  DiagnosticTag,
  DidChangeWatchedFilesNotification,
  ProposedFeatures,
  SemanticTokensBuilder,
  TextDocuments,
  TextDocumentSyncKind,
  CompletionItemKind
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";

// Hyperjump
import {
  setMetaSchemaOutputFormat,
  setShouldValidateSchema
} from "@hyperjump/json-schema";
import { hasDialect, DETAILED } from "@hyperjump/json-schema/experimental";
import "@hyperjump/json-schema/draft-2020-12";
import "@hyperjump/json-schema/draft-2019-09";
import "@hyperjump/json-schema/draft-07";
import "@hyperjump/json-schema/draft-06";
import "@hyperjump/json-schema/draft-04";

// Other
import { decomposeSchemaDocument, validate } from "./json-schema.js";
import { JsoncInstance } from "./jsonc-instance.js";
import { invalidNodes } from "./validation.js";
import {
  addWorkspaceFolders,
  workspaceSchemas,
  removeWorkspaceFolders,
  watchWorkspace,
  waitUntil
} from "./workspace.js";
import { getSemanticTokens } from "./semantic-tokens.js";


setMetaSchemaOutputFormat(DETAILED);
setShouldValidateSchema(false);

const isSchema = RegExp.prototype.test.bind(/(?:\.|\/|^)schema\.json$/);

const connection = createConnection(ProposedFeatures.all);
connection.console.log("Starting JSON Schema service ...");

let hasWorkspaceFolderCapability = false;
let hasWorkspaceWatchCapability = false;

connection.onInitialize(({ capabilities, workspaceFolders }) => {
  connection.console.log("Initializing JSON Schema service ...");

  if (workspaceFolders) {
    addWorkspaceFolders(workspaceFolders);
  }

  hasWorkspaceFolderCapability = !!capabilities.workspace?.workspaceFolders;
  hasWorkspaceWatchCapability
    = !!capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;

  const serverCapabilities = {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      resolveProvider: false, // Assuming you don't have a resolveProvider
      triggerCharacters: ["\"", ":", " "] // Might need to adjust for your use case
    },
    semanticTokensProvider: {
      legend: buildSemanticTokensLegend(capabilities.textDocument?.semanticTokens),
      range: false,
      full: {
        delta: true
      }
    }
  };

  if (capabilities.workspace?.workspaceFolders) {
    serverCapabilities.workspace = {
      workspaceFolders: {
        supported: true
      }
    };
  }

  return { capabilities: serverCapabilities };
});

connection.onInitialized(async () => {
  if (hasWorkspaceWatchCapability) {
    connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        { globPattern: "**/*.schema.json" },
        { globPattern: "**/schema.json" }
      ]
    });
  } else {
    watchWorkspace((_eventType, filename) => {
      if (isSchema(filename)) {
        validateWorkspace();
      }
    });
  }

  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(async ({ added, removed }) => {
      addWorkspaceFolders(added);
      removeWorkspaceFolders(removed);

      if (!hasWorkspaceWatchCapability) {
        watchWorkspace((_eventType, filename) => {
          if (isSchema(filename)) {
            validateWorkspace();
          }
        });
      }

      await validateWorkspace();
    });
  }

  await validateWorkspace();
});

let isWorkspaceLoaded = false;
const validateWorkspace = async () => {
  connection.console.log("Validating workspace");

  const reporter = await connection.window.createWorkDoneProgress();
  reporter.begin("JSON Schema: Indexing workspace");
  isWorkspaceLoaded = false;

  // Re/validate all schemas
  for await (const uri of workspaceSchemas()) {
    if (isSchema(uri)) {
      const textDocument = documents.get(uri);
      if (textDocument) {
        await validateSchema(textDocument);
      }
    }
  }

  isWorkspaceLoaded = true;
  reporter.done();
};

connection.onDidChangeWatchedFiles(validateWorkspace);

connection.listen();

const documents = new TextDocuments(TextDocument);

// INLINE ERRORS

documents.onDidChangeContent(async ({ document }) => {
  connection.console.log(`Schema changed: ${document.uri}`);

  if (isSchema(document.uri)) {
    await waitUntil(() => isWorkspaceLoaded);
    await validateSchema(document);
  }
});

const validateSchema = async (document) => {
  const diagnostics = [];

  const instance = JsoncInstance.fromTextDocument(document);
  const $schema = instance.get("#/$schema");
  const contextDialectUri = $schema.value();
  const schemaResources = decomposeSchemaDocument(instance, contextDialectUri);
  for (const { dialectUri, schemaInstance } of schemaResources) {
    if (!hasDialect(dialectUri)) {
      const $schema = schemaInstance.get("#/$schema");
      if ($schema.typeOf() === "string") {
        diagnostics.push(buildDiagnostic($schema, "Unknown dialect"));
      } else {
        diagnostics.push(buildDiagnostic(schemaInstance, "No dialect"));
      }

      continue;
    }

    const [output, annotations] = await validate(dialectUri, schemaInstance);

    if (!output.valid) {
      for await (const [instance, message] of invalidNodes(output)) {
        diagnostics.push(buildDiagnostic(instance, message));
      }
    }

    const deprecations = annotations.annotatedWith("deprecated");
    for (const deprecated of deprecations) {
      if (
        deprecated.annotation("deprecated").some((deprecated) => deprecated)
      ) {
        const message
          = deprecated.annotation("x-deprecationMessage").join("\n")
          || "deprecated";
        diagnostics.push(buildDiagnostic(
          deprecated.parent(),
          message,
          DiagnosticSeverity.Warning,
          [DiagnosticTag.Deprecated]
        ));
      }
    }
  }

  connection.sendDiagnostics({ uri: document.uri, diagnostics });
};

const buildDiagnostic = (
  instance,
  message,
  severity = DiagnosticSeverity.Error,
  tags = []
) => {
  return {
    severity: severity,
    tags: tags,
    range: {
      start: instance.startPosition(),
      end: instance.endPosition()
    },
    message: message,
    source: "json-schema"
  };
};

// SEMANTIC TOKENS

const semanticTokensLegend = {
  tokenTypes: {},
  tokenModifiers: {}
};

const buildSemanticTokensLegend = (capability) => {
  const clientTokenTypes = new Set(capability.tokenTypes);
  const serverTokenTypes = [
    "property",
    "keyword",
    "comment",
    "string",
    "regexp"
  ];

  const tokenTypes = [];
  for (const tokenType of serverTokenTypes) {
    if (clientTokenTypes.has(tokenType)) {
      semanticTokensLegend.tokenTypes[tokenType] = tokenTypes.length;
      tokenTypes.push(tokenType);
    }
  }

  const clientTokenModifiers = new Set(capability.tokenModifiers);
  const serverTokenModifiers = [];

  const tokenModifiers = [];
  for (const tokenModifier of serverTokenModifiers) {
    if (clientTokenModifiers.has(tokenModifier)) {
      semanticTokensLegend.tokenModifiers[tokenModifier]
        = tokenModifiers.length;
      tokenModifiers.push(tokenModifier);
    }
  }

  return { tokenTypes, tokenModifiers };
};

const tokenBuilders = new Map();
documents.onDidClose((event) => {
  tokenBuilders.delete(event.document.uri);
});

const getTokenBuilder = (uri) => {
  let result = tokenBuilders.get(uri);
  if (result !== undefined) {
    return result;
  }

  result = new SemanticTokensBuilder();
  tokenBuilders.set(uri, result);

  return result;
};

const buildTokens = (builder, document) => {
  const instance = JsoncInstance.fromTextDocument(document);
  const dialectUri = instance.get("#/$schema").value();
  const schemaResources = decomposeSchemaDocument(instance, dialectUri);
  for (const { keywordInstance, tokenType, tokenModifier } of getSemanticTokens(schemaResources)) {
    const startPosition = keywordInstance.startPosition();
    builder.push(
      startPosition.line,
      startPosition.character,
      keywordInstance.textLength(),
      semanticTokensLegend.tokenTypes[tokenType] ?? 0,
      semanticTokensLegend.tokenModifiers[tokenModifier] ?? 0
    );
  }
};

connection.languages.semanticTokens.on(({ textDocument }) => {
  connection.console.log(`semanticTokens.on: ${textDocument.uri}`);

  if (isSchema(textDocument.uri)) {
    const builder = getTokenBuilder(textDocument.uri);
    const document = documents.get(textDocument.uri);
    buildTokens(builder, document);

    return builder.build();
  } else {
    return { data: [] };
  }
});

connection.languages.semanticTokens.onDelta(({ textDocument, previousResultId }) => {
  connection.console.log(`semanticTokens.onDelta: ${textDocument.uri}`);

  const document = documents.get(textDocument.uri);
  if (document === undefined) {
    return { edits: [] };
  }

  const builder = getTokenBuilder(document);
  builder.previousResult(previousResultId);
  buildTokens(builder, document);

  return builder.buildEdits();
});

function findPropertyAtPosition(instance, position) {
  for (const [key, value] of instance.entries()) {
    if (
      position.line >= key.startPosition().line
      && position.character >= key.startPosition().character
      && position.line <= value.endPosition().lastIndexOf()
      && position.character <= value.endPosition().character
    ) {
      return { key, value }; // Return both key and value
    }
  }
  return undefined;
}

connection.onCompletion((textDocumentPosition) => {
  const doc = documents.get(textDocumentPosition.textDocument.uri);
  connection.console.log("Completion is Triggered !");

  if (!doc) {
    return [];
  }

  const schemaSuggestions = [
    "http://json-schema.org/draft-07/schema#",
    "http://json-schema.org/draft-04/schema",
    "http://json-schema.org/draft-06/schema",
    "http://json-schema.org/draft-07/schema"
  ];

  const instance = JsoncInstance.fromTextDocument(doc);
  const currentProperty = findPropertyAtPosition(
    instance,
    textDocumentPosition.position
  );

  if (currentProperty?.key.value() === "$schema") {
    connection.console.log("***** Found the $schema keywork *****");
    // const currentSchemaURI = currentProperty.value.value();
    //  Your list of schema URIs

    return schemaSuggestions.map((uri) => {
      return {
        label: uri,
        kind: CompletionItemKind.Keyword
      };
    });
  }
  connection.console.log("***** Didn't find the $schema keywork *****");
});

documents.listen(connection);
