#!/usr/bin/env node

// 为老版本 Node.js 添加 AbortController polyfill
import AbortController from 'abort-controller';
global.AbortController = global.AbortController || AbortController;

/**
 * Metabase MCP 服务器
 * 实现与 Metabase API 的交互，提供以下功能：
 * - 获取仪表板列表
 * - 获取问题列表
 * - 获取数据库列表
 * - 执行问题查询
 * - 获取仪表板详情
 */
import pkg from "../package.json" with { type: "json" };
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CallToolRequestSchema,
  ListResourcesResult,
  ReadResourceResult,
  ResourceSchema,
  ToolSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import axios, { AxiosInstance } from "axios";
import { assert } from 'console';

// 自定义错误枚举
enum ErrorCode {
  InternalError = "internal_error",
  InvalidRequest = "invalid_request",
  InvalidParams = "invalid_params",
  MethodNotFound = "method_not_found"
}

// 自定义错误类
class McpError extends Error {
  code: ErrorCode;
  
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "McpError";
  }
}

// 从环境变量获取 Metabase 配置
const METABASE_URL = process.env.METABASE_URL;
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;
const METABASE_API_KEY = process.env.METABASE_API_KEY;
const METABASE_DATABASE_ID = 2; // 默认 ClickHouse 数据库 ID

if (!METABASE_URL || (!METABASE_API_KEY && (!METABASE_USERNAME || !METABASE_PASSWORD))) {
  throw new Error(
    "Either (METABASE_URL and METABASE_API_KEY) or (METABASE_URL, METABASE_USERNAME, and METABASE_PASSWORD) environment variables are required"
  );
}

// 创建自定义 Schema 对象，使用 z.object
const ListResourceTemplatesRequestSchema = z.object({
  method: z.literal("resources/list_templates")
});

const ListToolsRequestSchema = z.object({
  method: z.literal("tools/list")
});

class MetabaseServer {
  private server: Server;
  private axiosInstance: AxiosInstance;
  private sessionToken: string | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "metabase-server",
        version: pkg.version,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: METABASE_URL,
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (METABASE_API_KEY) {
      this.logInfo('Using Metabase API Key for authentication.');
      this.axiosInstance.defaults.headers.common['X-API-Key'] = METABASE_API_KEY;
      this.sessionToken = "api_key_used"; // Indicate API key is in use
    } else if (METABASE_USERNAME && METABASE_PASSWORD) {
      this.logInfo('Using Metabase username/password for authentication.');
      // Existing session token logic will apply
    } else {
      // This case should ideally be caught by the initial environment variable check
      // but as a safeguard:
      this.logError('Metabase authentication credentials not configured properly.', {});
      throw new Error("Metabase authentication credentials not provided or incomplete.");
    }

    this.setupResourceHandlers();
    this.setupToolHandlers();
    
    // Enhanced error handling with logging
    this.server.onerror = (error: Error) => {
      this.logError('Server Error', error);
    };

    process.on('SIGINT', async () => {
      this.logInfo('Shutting down server...');
      await this.server.close();
      process.exit(0);
    });
  }

  // Add logging utilities
  private logInfo(message: string, data?: unknown) {
    const logMessage = {
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      data
    };
    console.error(JSON.stringify(logMessage));
    // MCP SDK changed, can't directly access session
    try {
      // Use current session if available
      console.error(`INFO: ${message}`);
    } catch (e) {
      // Ignore if session not available
    }
  }

  private logError(message: string, error: unknown) {
    const errorObj = error as Error;
    const apiError = error as { response?: { data?: { message?: string } }, message?: string };
    
    const logMessage = {
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      error: errorObj.message || 'Unknown error',
      stack: errorObj.stack
    };
    console.error(JSON.stringify(logMessage));
    // MCP SDK changed, can't directly access session
    try {
      console.error(`ERROR: ${message} - ${errorObj.message || 'Unknown error'}`);
    } catch (e) {
      // Ignore if session not available
    }
  }

  /**
   * 获取 Metabase 会话令牌
   */
  private async getSessionToken(): Promise<string> {
    if (this.sessionToken) { // Handles both API key ("api_key_used") and actual session tokens
      return this.sessionToken;
    }

    // This part should only be reached if using username/password and sessionToken is null
    this.logInfo('Authenticating with Metabase using username/password...');
    try {
      const response = await this.axiosInstance.post('/api/session', {
        username: METABASE_USERNAME,
        password: METABASE_PASSWORD,
      });

      this.sessionToken = response.data.id;
      
      // 设置默认请求头
      this.axiosInstance.defaults.headers.common['X-Metabase-Session'] = this.sessionToken;
      
      this.logInfo('Successfully authenticated with Metabase');
      return this.sessionToken as string;
    } catch (error) {
      this.logError('Authentication failed', error);
      throw new McpError(
        ErrorCode.InternalError,
        'Failed to authenticate with Metabase'
      );
    }
  }

  /**
   * 设置资源处理程序
   */
  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      this.logInfo('Listing resources...', { requestStructure: JSON.stringify(request) });
      if (!METABASE_API_KEY) {
        await this.getSessionToken();
      }

      try {
        // 获取仪表板列表
        const dashboardsResponse = await this.axiosInstance.get('/api/dashboard');
        
        this.logInfo('Successfully listed resources', { count: dashboardsResponse.data.length });
        // 将仪表板作为资源返回
        return {
          resources: dashboardsResponse.data.map((dashboard: any) => ({
            uri: `metabase://dashboard/${dashboard.id}`,
            mimeType: "application/json",
            name: dashboard.name,
            description: `Metabase dashboard: ${dashboard.name}`
          }))
        };
      } catch (error) {
        this.logError('Failed to list resources', error);
        throw new McpError(
          ErrorCode.InternalError,
          'Failed to list Metabase resources'
        );
      }
    });

    // 资源模板
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return {
        resourceTemplates: [
          {
            uriTemplate: 'metabase://dashboard/{id}',
            name: 'Dashboard by ID',
            mimeType: 'application/json',
            description: 'Get a Metabase dashboard by its ID',
          },
          {
            uriTemplate: 'metabase://card/{id}',
            name: 'Card by ID',
            mimeType: 'application/json',
            description: 'Get a Metabase question/card by its ID',
          },
          {
            uriTemplate: 'metabase://database/{id}',
            name: 'Database by ID',
            mimeType: 'application/json',
            description: 'Get a Metabase database by its ID',
          },
        ],
      };
    });

    // 读取资源
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      this.logInfo('Reading resource...', { requestStructure: JSON.stringify(request) });
      if (!METABASE_API_KEY) {
        await this.getSessionToken();
      }

      const uri = request.params?.uri;
      let match;

      try {
        // 处理仪表板资源
        if ((match = uri.match(/^metabase:\/\/dashboard\/(\d+)$/))) {
          const dashboardId = match[1];
          const response = await this.axiosInstance.get(`/api/dashboard/${dashboardId}`);
          
          return {
            contents: [{
              uri: request.params?.uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        
        // 处理问题/卡片资源
        else if ((match = uri.match(/^metabase:\/\/card\/(\d+)$/))) {
          const cardId = match[1];
          const response = await this.axiosInstance.get(`/api/card/${cardId}`);
          
          return {
            contents: [{
              uri: request.params?.uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        
        // 处理数据库资源
        else if ((match = uri.match(/^metabase:\/\/database\/(\d+)$/))) {
          const databaseId = match[1];
          const response = await this.axiosInstance.get(`/api/database/${databaseId}`);
          
          return {
            contents: [{
              uri: request.params?.uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        
        else {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid URI format: ${uri}`
          );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Metabase API error: ${error.response?.data?.message || error.message}`
          );
        }
        throw error;
      }
    });
  }

  /**
   * 设置工具处理程序
   */
  private setupToolHandlers() {
    // No session token needed for listing tools, as it's static data
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "list_dashboards",
            description: "List all dashboards in Metabase",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "list_cards",
            description: "List all questions/cards in Metabase",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "list_databases",
            description: "List all databases in Metabase",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "execute_card",
            description: "Execute a Metabase question/card and get results",
            inputSchema: {
              type: "object",
              properties: {
                card_id: {
                  type: "number",
                  description: "ID of the card/question to execute"
                },
                parameters: {
                  type: "object",
                  description: "Optional parameters for the query"
                }
              },
              required: ["card_id"]
            }
          },
          {
            name: "get_dashboard_cards",
            description: "Get all cards in a dashboard",
            inputSchema: {
              type: "object",
              properties: {
                dashboard_id: {
                  type: "number",
                  description: "ID of the dashboard"
                }
              },
              required: ["dashboard_id"]
            }
          },
          {
            name: "execute_query",
            description: "Execute a SQL query against a Metabase database",
            inputSchema: {
              type: "object",
              properties: {
                database_id: {
                  type: "number",
                  description: "ID of the database to query"
                },
                query: {
                  type: "string",
                  description: "SQL query to execute"
                },
                native_parameters: {
                  type: "array",
                  description: "Optional parameters for the query",
                  items: {
                    type: "object"
                  }
                }
              },
              required: ["database_id", "query"]
            }
          },
          {
            name: "get_field_id",
            description: "Get the field ID for a specific field in a table. This is useful for creating field filters in Metabase.",
            inputSchema: {
              type: "object",
              properties: {
                table_name: {
                  type: "string",
                  description: "Name of the table"
                },
                field_name: {
                  type: "string",
                  description: "Name of the field"
                }
              },
              required: ["table_name", "field_name"]
            }
          },
          {
            name: "create_card",
            description: "Create a new Metabase question (card).",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name of the card" },
                dataset_query: {
                  type: "object",
                  description: "The query for the card (e.g., MBQL or native query)",
                  properties: {
                    type: { type: "string", enum: ["native"], description: "Query type" },
                    native: {
                      type: "object",
                      properties: {
                        query: { type: "string", description: "SQL query string" },
                        template_tags: {
                          type: "object",
                          description: "Template tags for parameters",
                          additionalProperties: {
                            type: "object",
                            properties: {
                              id: { type: "string", description: "Parameter ID" },
                              name: { type: "string", description: "Parameter name" },
                              display_name: { type: "string", description: "Display name" },
                              type: { type: "string", description: "Parameter type. Use 'dimension' for field filter" },
                              dimension: {
                                type: "array",
                                description: "Dimension for field filter, format: ['field-id', field_id_number]",
                                items: {
                                  oneOf: [
                                    {type: "string", enum: ["field-id"], description: "Field ID identifier"},
                                    {type: "number", description: "Field ID number"}
                                  ]
                                }
                              },
                              default: { }, // can be any type
                            },
                            required: ["id", "name", "type"]
                          }
                        }
                      },
                      required: ["query"]
                    },
                    database: { type: "number", description: "Database ID" }
                  },
                  required: ["type", "native", "database"]
                },
                display: { type: "string", description: "Display type (e.g., 'table', 'line', 'bar')" },
                visualization_settings: { type: "object", description: "Settings for the visualization" },
                collection_id: { type: "number", description: "Optional ID of the collection to save the card in" },
                description: { type: "string", description: "Optional description for the card" }
              },
              required: ["name", "dataset_query", "display", "visualization_settings"]
            }
          },
          {
            name: "update_card",
            description: "Update an existing Metabase question (card).",
            inputSchema: {
              type: "object",
              properties: {
                card_id: { type: "number", description: "ID of the card to update" },
                name: { type: "string", description: "New name for the card" },
                dataset_query: {
                  type: "object",
                  description: "The query for the card (e.g., MBQL or native query)",
                  properties: {
                    type: { type: "string", enum: ["native"], description: "Query type" },
                    native: {
                      type: "object",
                      properties: {
                        query: { type: "string", description: "SQL query string" },
                        template_tags: {
                          type: "object",
                          description: "Template tags for parameters",
                          additionalProperties: {
                            type: "object",
                            properties: {
                              id: { type: "string", description: "Parameter ID" },
                              name: { type: "string", description: "Parameter name" },
                              display_name: { type: "string", description: "Display name" },
                              type: { type: "string", description: "Parameter type" },
                              default: { }, // can be any type
                            },
                            required: ["id", "name", "type"]
                          }
                        }
                      },
                      required: ["query"]
                    },
                    database: { type: "number", description: "Database ID" }
                  }
                },
                display: { type: "string", description: "New display type" },
                visualization_settings: { type: "object", description: "New visualization settings" },
                collection_id: { type: "number", description: "New collection ID" },
                description: { type: "string", description: "New description" },
                archived: { type: "boolean", description: "Set to true to archive the card" }
              },
              required: ["card_id"]
            }
          },
          {
            name: "delete_card",
            description: "Delete a Metabase question (card).",
            inputSchema: {
              type: "object",
              properties: {
                card_id: { type: "number", description: "ID of the card to delete" },
                hard_delete: { type: "boolean", description: "Set to true for hard delete, false (default) for archive", default: false }
              },
              required: ["card_id"]
            }
          },
          {
            name: "create_dashboard",
            description: "Create a new Metabase dashboard.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name of the dashboard" },
                description: { type: "string", description: "Optional description for the dashboard" },
                parameters: { type: "array", description: "Optional parameters for the dashboard", items: { type: "object" } },
                collection_id: { type: "number", description: "Optional ID of the collection to save the dashboard in" }
              },
              required: ["name"]
            }
          },
          {
            name: "update_dashboard",
            description: "Update an existing Metabase dashboard or add cards to the dashboard.",
            inputSchema: {
              type: "object",
              properties: {
                dashboard_id: { type: "number", description: "ID of the dashboard to update" },
                name: { type: "string", description: "New name for the dashboard" },
                description: { type: "string", description: "New description for the dashboard" },
                parameters: { 
                  type: "array", 
                  description: "New parameters for the dashboard, this can be used to filter the cards in the dashboard", 
                  items: { 
                    type: "object",
                    properties: {
                      id: { type: "string", description: "Unique identifier for the parameter" },
                      name: { type: "string", description: "Name of the parameter" },
                      type: { type: "string", description: "Type of the parameter (e.g., 'text', 'number', 'date'). For field filters, use 'category'." },
                      default: { description: "Default value for the parameter" }
                    },
                    required: ["id", "name", "type"]
                  } 
                },
                collection_id: { type: "number", description: "New collection ID" },
                dashcards: { type: "array", description: "Cards to add to the dashboard", items: { 
                  type: "object",
                  properties: {
                    card_id: { type: "number", description: "ID of the card to add" },
                    size_x: { type: "number", description: "Width of the card in grid units" },
                    size_y: { type: "number", description: "Height of the card in grid units" },
                    row: { type: "number", description: "Row position in the dashboard grid" },
                    col: { type: "number", description: "Column position in the dashboard grid" },
                    id: { type: "number", description: "ID for the card in the dashboard, this has to be unique" },
                    parameter_mappings: {
                      type: "array",
                      description: "parameter mappings for the card, this is used to filter the card based on the dashboard parameters",
                      items: {
                        type: "object",
                        properties: {
                          parameter_id: { type: "string", description: "ID of the parameter to map" },
                          card_id: { type: "number", description: "ID of the card to map the parameter to" },
                          target: {
                            type: "array",
                            description: "Target field format: ['variable', ['template-tag', 'parameter_name']]",
                            items: {
                              oneOf: [
                                {type: "string", enum: ["variable", "dimension"], description: "Target type, 'variable' for variable mapping, 'dimension' for field filter"},
                                {type: "array", items: {type: "string", description: "The first element is always 'template-tag', the second element is the parameter name"}}
                              ]
                            },
                          }  
                        }
                      }
                    }
                  },
                  required: ["card_id", "size_x", "size_y", "row", "col", "id"] 
                } },
                archived: { type: "boolean", description: "Set to true to archive the dashboard" }
              },
              required: ["dashboard_id"]
            }
          },
          {
            name: "delete_dashboard",
            description: "Delete a Metabase dashboard.",
            inputSchema: {
              type: "object",
              properties: {
                dashboard_id: { type: "number", description: "ID of the dashboard to delete" },
                hard_delete: { type: "boolean", description: "Set to true for hard delete, false (default) for archive", default: false }
              },
              required: ["dashboard_id"]
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logInfo('Calling tool...', { requestStructure: JSON.stringify(request) });
      if (!METABASE_API_KEY) {
        await this.getSessionToken();
      }

      try {
        switch (request.params?.name) {
          case "list_dashboards": {
            const response = await this.axiosInstance.get('/api/dashboard');
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data.map((d: any) => ({id: d.id, name: d.name, view_count: d.view_count})), null, 2)
              }]
            };
          }

          case "list_cards": {
            const response = await this.axiosInstance.get('/api/card');
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data.length, null, 2)
              }]
            };
          }

          case "list_databases": {
            const response = await this.axiosInstance.get('/api/database');
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data.data.map((d: any) => ({id: d.id, name: d.name})), null, 2)
              }]
            };
          }

          case "execute_card": {
            const cardId = request.params?.arguments?.card_id;
            if (!cardId) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Card ID is required"
              );
            }

            const parameters = request.params?.arguments?.parameters || {};
            const response = await this.axiosInstance.post(`/api/card/${cardId}/query`, { parameters });
            
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "get_dashboard_cards": {
            const dashboardId = request.params?.arguments?.dashboard_id;
            if (!dashboardId) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Dashboard ID is required"
              );
            }

            const response = await this.axiosInstance.get(`/api/dashboard/${dashboardId}`);
            
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data.dashcards, null, 2)
              }]
            };
          }
          
          case "execute_query": {
            const databaseId = request.params?.arguments?.database_id;
            const query = request.params?.arguments?.query;
            const nativeParameters = request.params?.arguments?.native_parameters || [];
            
            if (!databaseId) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Database ID is required"
              );
            }
            
            if (!query) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "SQL query is required"
              );
            }
            
            // 构建查询请求体
            const queryData = {
              type: "native",
              native: {
                query: query,
                template_tags: {}
              },
              parameters: nativeParameters,
              database: databaseId
            };
            
            const response = await this.axiosInstance.post('/api/dataset', queryData);
            
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "get_field_id": {
            const { table_name, field_name } = request.params?.arguments || {};
            if (!table_name || !field_name) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Missing required fields for get_field_filter_id: table_name, field_name"
              );  
            }
            const response = await this.axiosInstance.get("/api/search", {
              params: {
                q: table_name,
                type: "table",
              }
            });
            interface MetabaseTableSearchResult {
              id: number;
              name: string;
              table_name: string;
              database_id: number;
            }

            const table: MetabaseTableSearchResult | undefined = response.data.data.find(
              (r: MetabaseTableSearchResult) => r.table_name === table_name && r.database_id === METABASE_DATABASE_ID
            );
            if (!table) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Table not found: ${table_name}`
              );
            }
            const table_id = table.id;

            const table_metadata = await this.axiosInstance.get(`/api/table/${table_id}/query_metadata`);
            const field = table_metadata.data.fields.find((f: any) => f.name === field_name);
            if (!field) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Field not found: ${field_name} in table ${table_name}`
              );
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  field_id: field.id,
                  table_id: table_id,
                  table_name: table_name,
                  field_name: field_name
                }, null, 2)
              }]
            };
          }


          case "create_card": {
            const { name, dataset_query, display, visualization_settings, collection_id, description } = request.params?.arguments || {};
            if (!name || !dataset_query || !display || !visualization_settings) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Missing required fields for create_card: name, dataset_query, display, visualization_settings"
              );
            }
            const createCardBody: any = {
              name,
              dataset_query,
              display,
              visualization_settings,
            };
            if (collection_id !== undefined) createCardBody.collection_id = collection_id;
            if (description !== undefined) createCardBody.description = description;

            const response = await this.axiosInstance.post('/api/card', createCardBody);
            const {id} = response.data
            return {
              content: [{
                type: "text",
                text: JSON.stringify({id, name, dataset_query, display, visualization_settings}, null, 2)
              }]
            };
          }

          case "update_card": {
            const { card_id, ...updateFields } = request.params?.arguments || {};
            if (!card_id) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Card ID is required for update_card"
              );
            }
            if (Object.keys(updateFields).length === 0) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "No fields provided for update_card"
              );
            }
            const response = await this.axiosInstance.put(`/api/card/${card_id}`, updateFields);
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "delete_card": {
            const { card_id, hard_delete = false } = request.params?.arguments || {};
            if (!card_id) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Card ID is required for delete_card"
              );
            }

            if (hard_delete) {
              await this.axiosInstance.delete(`/api/card/${card_id}`);
              return {
                content: [{
                  type: "text",
                  text: `Card ${card_id} permanently deleted.`
                }]
              };
            } else {
              // Soft delete (archive)
              const response = await this.axiosInstance.put(`/api/card/${card_id}`, { archived: true });
              return {
                content: [{
                  type: "text",
                  // Metabase might return the updated card object or just a success status.
                  // If response.data is available and meaningful, include it. Otherwise, a generic success message.
                  text: response.data ? `Card ${card_id} archived. Details: ${JSON.stringify(response.data, null, 2)}` : `Card ${card_id} archived.`
                }]
              };
            }
          }

          case "create_dashboard": {
            const { name, description, parameters, collection_id } = request.params?.arguments || {};
            if (!name) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Missing required field for create_dashboard: name"
              );
            }
            const createDashboardBody: any = { name };
            if (description !== undefined) createDashboardBody.description = description;
            if (parameters !== undefined) createDashboardBody.parameters = parameters;
            if (collection_id !== undefined) createDashboardBody.collection_id = collection_id;

            const response = await this.axiosInstance.post('/api/dashboard', createDashboardBody);
            const {id} = response.data;
            return {
              content: [{
                type: "text",
                text: JSON.stringify({id, name, description, parameters}, null, 2)
              }]
            };
          }

          case "update_dashboard": {
            const { dashboard_id, ...updateFields } = request.params?.arguments || {};
            if (!dashboard_id) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Dashboard ID is required for update_dashboard"
              );
            }
            if (Object.keys(updateFields).length === 0) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "No fields provided for update_dashboard"
              );
            }
            const response = await this.axiosInstance.put(`/api/dashboard/${dashboard_id}`, updateFields);
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "delete_dashboard": {
            const { dashboard_id, hard_delete = false } = request.params?.arguments || {};
            if (!dashboard_id) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Dashboard ID is required for delete_dashboard"
              );
            }

            if (hard_delete) {
              await this.axiosInstance.delete(`/api/dashboard/${dashboard_id}`);
              return {
                content: [{
                  type: "text",
                  text: `Dashboard ${dashboard_id} permanently deleted.`
                }]
              };
            } else {
              // Soft delete (archive)
              const response = await this.axiosInstance.put(`/api/dashboard/${dashboard_id}`, { archived: true });
               return {
                content: [{
                  type: "text",
                  text: response.data ? `Dashboard ${dashboard_id} archived. Details: ${JSON.stringify(response.data, null, 2)}` : `Dashboard ${dashboard_id} archived.`
                }]
              };
            }
          }
          
          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown tool: ${request.params?.name}`
                }
              ],
              isError: true
            };
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Metabase API error: ${error.response?.data?.message || error.message}`
            }],
            isError: true
          };
        }
        throw error;
      }
    });
  }

  async run() {
    try {
      this.logInfo(`Starting Metabase MCP server version ${pkg.version}...`);
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      this.logInfo('Metabase MCP server running on stdio');
    } catch (error) {
      this.logError('Failed to start server', error);
      throw error;
    }
  }
}

// Add global error handlers
process.on('uncaughtException', (error: Error) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    message: 'Uncaught Exception',
    error: error.message,
    stack: error.stack
  }));
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    message: 'Unhandled Rejection',
    error: errorMessage
  }));
});

const server = new MetabaseServer();
server.run().catch(console.error);
