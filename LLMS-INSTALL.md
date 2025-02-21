# AI Agent Installation Guide

This guide is specifically designed for AI agents like Cline to help with installing and configuring the PayPal MCP server.

## Repository Structure

```
paypal-server/
├── src/
│   └── index.ts          # Main server implementation
├── .github/
│   └── workflows/
│       └── ci.yml        # GitHub Actions workflow
├── package.json          # Node.js dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── README.md            # General documentation
├── LICENSE             # MIT license
└── .gitignore         # Git ignore rules
```

## Installation Steps

1. **Project Setup**
   ```bash
   # Create project directory
   mkdir paypal-server
   cd paypal-server

   # Initialize Node.js project
   npm init -y

   # Install dependencies
   npm install @modelcontextprotocol/sdk axios typescript @types/node
   ```

2. **TypeScript Configuration**
   - Ensure tsconfig.json is configured for ES modules
   - Set target to ES2020 or later
   - Enable strict type checking

3. **Environment Configuration**
   When helping users set up PayPal credentials:
   1. Direct them to https://developer.paypal.com/dashboard/
   2. Guide them through creating a REST API app
   3. Help them securely store the Client ID and Secret

## MCP Configuration

### Settings File Location
- Windows: `%APPDATA%/Windsurf/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/claude/settings.json`

### Configuration Template
```json
{
  "mcpServers": {
    "paypal": {
      "command": "node",
      "args": ["path/to/paypal-server/build/index.js"],
      "env": {
        "PAYPAL_CLIENT_ID": "your_client_id",
        "PAYPAL_CLIENT_SECRET": "your_client_secret"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Validation Steps

When implementing the server:
1. Verify TypeScript compilation succeeds
2. Check all API endpoints are properly typed
3. Ensure error handling is comprehensive
4. Validate input parameters thoroughly

## Common Issues and Solutions

### Type Safety
- Always use proper type validation for PayPal API responses
- Implement interface checks for all input parameters
- Use type guards for error handling

### Authentication
- Handle token expiration and refresh
- Validate credentials before making API calls
- Secure storage of API keys

### Error Handling
- Implement specific error types for different scenarios
- Provide clear error messages
- Handle network and API failures gracefully

## Testing Instructions

For validating the installation:

1. **Credential Verification**
   ```typescript
   const result = await mcpClient.useTool('paypal', 'create_order', {
     intent: 'CAPTURE',
     purchase_units: [{
       amount: {
         currency_code: 'USD',
         value: '1.00'
       }
     }]
   });
   ```

2. **Error Handling Test**
   ```typescript
   // Test invalid credentials
   const result = await mcpClient.useTool('paypal', 'create_order', {
     // Invalid parameters to test error handling
   });
   ```

## Security Best Practices

When implementing for users:
1. Never store credentials in code
2. Use environment variables for sensitive data
3. Validate all input parameters
4. Implement proper error handling
5. Use HTTPS for all API calls

## Debugging Guide

Common issues to check:
1. TypeScript compilation errors
2. PayPal API authentication failures
3. Input validation errors
4. Network connectivity issues

## Version Compatibility

- Node.js: 16.x or later
- TypeScript: 5.0 or later
- MCP SDK: latest version
- PayPal API: v2 endpoints

## Additional Resources

- [PayPal API Documentation](https://developer.paypal.com/docs/api/overview/)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/typescript-sdk)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

## Support

For issues or questions:
- GitHub Issues: [Create an issue](https://github.com/DynamicEndpoints/Paypal-MCP/issues)
- Contact: kameron@dynamicendpoints.com
