#!/usr/bin/env node

/**
 * Real-World Application Example for @blendsdk/cmdline
 *
 * This example demonstrates a complete CLI application for a fictional
 * project management tool with multiple commands and realistic functionality:
 * - Project management (create, list, delete)
 * - Task management (add, complete, list)
 * - User management (add, remove, list)
 * - Reporting and statistics
 * - Configuration management
 *
 * To run this example:
 * npx ts-node examples/04-real-world-app.ts project create --name="My Project" --description="A sample project"
 * npx ts-node examples/04-real-world-app.ts task add --project=1 --title="Implement feature" --priority=high
 * npx ts-node examples/04-real-world-app.ts user add --name="John Doe" --email="john@example.com" --role=developer
 * npx ts-node examples/04-real-world-app.ts report --type=summary
 */

import { CommandLineParser } from '../src/index';

// Simulated database/storage
interface Project {
  id: number;
  name: string;
  description?: string;
  status: 'active' | 'completed' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

interface Task {
  id: number;
  projectId: number;
  title: string;
  description?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'todo' | 'in-progress' | 'completed';
  assigneeId?: number;
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
}

interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'developer' | 'tester';
  active: boolean;
  createdAt: Date;
}

// Mock data storage
const mockData = {
  projects: [
    {
      id: 1,
      name: 'Website Redesign',
      description: 'Complete redesign of company website',
      status: 'active' as const,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-15'),
    },
    {
      id: 2,
      name: 'Mobile App',
      description: 'iOS and Android mobile application',
      status: 'active' as const,
      createdAt: new Date('2024-01-10'),
      updatedAt: new Date('2024-01-20'),
    },
  ] as Project[],
  tasks: [
    {
      id: 1,
      projectId: 1,
      title: 'Design mockups',
      priority: 'high' as const,
      status: 'completed' as const,
      assigneeId: 1,
      createdAt: new Date('2024-01-02'),
      updatedAt: new Date('2024-01-05'),
    },
    {
      id: 2,
      projectId: 1,
      title: 'Implement homepage',
      priority: 'medium' as const,
      status: 'in-progress' as const,
      assigneeId: 2,
      createdAt: new Date('2024-01-05'),
      updatedAt: new Date('2024-01-10'),
    },
    {
      id: 3,
      projectId: 2,
      title: 'Setup development environment',
      priority: 'high' as const,
      status: 'todo' as const,
      createdAt: new Date('2024-01-12'),
      updatedAt: new Date('2024-01-12'),
    },
  ] as Task[],
  users: [
    {
      id: 1,
      name: 'Alice Johnson',
      email: 'alice@company.com',
      role: 'manager' as const,
      active: true,
      createdAt: new Date('2023-12-01'),
    },
    {
      id: 2,
      name: 'Bob Smith',
      email: 'bob@company.com',
      role: 'developer' as const,
      active: true,
      createdAt: new Date('2023-12-05'),
    },
    {
      id: 3,
      name: 'Carol Davis',
      email: 'carol@company.com',
      role: 'tester' as const,
      active: true,
      createdAt: new Date('2023-12-10'),
    },
  ] as User[],
};

const parser = new CommandLineParser({
  name: 'project-manager',
  version: '1.0.0',
});

// Project Management Commands
parser.addCommand({
  name: 'project',
  description: 'Project management operations',
  handler: async () => {
    console.log('📋 Project Management');
    console.log('Available subcommands: create, list, show, update, delete, archive');
    console.log('Use --help with any subcommand for more information.');
  },
});

parser.addCommand({
  name: 'project-create',
  description: 'Create a new project',
  options: [
    {
      name: 'name',
      short: 'n',
      type: 'string',
      description: 'Project name',
      required: true,
    },
    {
      name: 'description',
      short: 'd',
      type: 'string',
      description: 'Project description',
    },
    {
      name: 'status',
      short: 's',
      type: 'string',
      description: 'Initial project status',
      choices: ['active', 'completed', 'archived'],
      default: 'active',
    },
  ],
  handler: async options => {
    const newProject: Project = {
      id: Math.max(...mockData.projects.map(p => p.id), 0) + 1,
      name: options.name.toString(),
      description: options.description?.toString(),
      status: options.status as 'active' | 'completed' | 'archived',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockData.projects.push(newProject);

    console.log('✅ Project created successfully!');
    console.log(`📋 ID: ${newProject.id}`);
    console.log(`📝 Name: ${newProject.name}`);
    console.log(`📄 Description: ${newProject.description || 'None'}`);
    console.log(`📊 Status: ${newProject.status}`);
    console.log(`📅 Created: ${newProject.createdAt.toLocaleDateString()}`);
  },
});

parser.addCommand({
  name: 'project-list',
  description: 'List all projects',
  options: [
    {
      name: 'status',
      short: 's',
      type: 'string',
      description: 'Filter by status',
      choices: ['active', 'completed', 'archived'],
    },
    {
      name: 'format',
      short: 'f',
      type: 'string',
      description: 'Output format',
      choices: ['table', 'json', 'csv'],
      default: 'table',
    },
  ],
  handler: async options => {
    let projects = mockData.projects;

    if (options.status) {
      projects = projects.filter(p => p.status === options.status);
    }

    console.log(`📋 Projects (${projects.length} found)`);
    console.log('='.repeat(50));

    if (options.format === 'json') {
      console.log(JSON.stringify(projects, null, 2));
    } else if (options.format === 'csv') {
      console.log('ID,Name,Description,Status,Created,Updated');
      projects.forEach(p => {
        console.log(
          `${p.id},"${p.name}","${p.description || ''}",${p.status},${p.createdAt.toISOString()},${p.updatedAt.toISOString()}`
        );
      });
    } else {
      projects.forEach(project => {
        console.log(`📋 ${project.id}: ${project.name}`);
        console.log(`   📄 ${project.description || 'No description'}`);
        console.log(`   📊 Status: ${project.status}`);
        console.log(`   📅 Created: ${project.createdAt.toLocaleDateString()}`);
        console.log('');
      });
    }
  },
});

// Task Management Commands
parser.addCommand({
  name: 'task-add',
  description: 'Add a new task to a project',
  options: [
    {
      name: 'project',
      short: 'p',
      type: 'number',
      description: 'Project ID',
      required: true,
      validator: value => {
        const projectId = typeof value === 'number' ? value : parseInt(value.toString());
        const project = mockData.projects.find(p => p.id === projectId);
        return project ? true : `Project with ID ${projectId} not found`;
      },
    },
    {
      name: 'title',
      short: 't',
      type: 'string',
      description: 'Task title',
      required: true,
    },
    {
      name: 'description',
      short: 'd',
      type: 'string',
      description: 'Task description',
    },
    {
      name: 'priority',
      type: 'string',
      description: 'Task priority',
      choices: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    {
      name: 'assignee',
      short: 'a',
      type: 'number',
      description: 'Assignee user ID',
      validator: value => {
        const userId = typeof value === 'number' ? value : parseInt(value.toString());
        const user = mockData.users.find(u => u.id === userId && u.active);
        return user ? true : `Active user with ID ${userId} not found`;
      },
    },
    {
      name: 'due-date',
      type: 'string',
      description: 'Due date (YYYY-MM-DD format)',
      validator: value => {
        const date = new Date(value.toString());
        return !isNaN(date.getTime()) || 'Invalid date format. Use YYYY-MM-DD';
      },
    },
  ],
  handler: async options => {
    const projectId =
      typeof options.project === 'number' ? options.project : parseInt(options.project.toString());
    const project = mockData.projects.find(p => p.id === projectId);

    const newTask: Task = {
      id: Math.max(...mockData.tasks.map(t => t.id), 0) + 1,
      projectId,
      title: options.title.toString(),
      description: options.description?.toString(),
      priority: options.priority as 'low' | 'medium' | 'high' | 'critical',
      status: 'todo',
      assigneeId: options.assignee
        ? typeof options.assignee === 'number'
          ? options.assignee
          : parseInt(options.assignee.toString())
        : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
      dueDate: options['due-date'] ? new Date(options['due-date'].toString()) : undefined,
    };

    mockData.tasks.push(newTask);

    console.log('✅ Task created successfully!');
    console.log(`🆔 ID: ${newTask.id}`);
    console.log(`📋 Project: ${project?.name} (${projectId})`);
    console.log(`📝 Title: ${newTask.title}`);
    console.log(`📄 Description: ${newTask.description || 'None'}`);
    console.log(`⚡ Priority: ${newTask.priority}`);
    console.log(`📊 Status: ${newTask.status}`);

    if (newTask.assigneeId) {
      const assignee = mockData.users.find(u => u.id === newTask.assigneeId);
      console.log(`👤 Assignee: ${assignee?.name} (${assignee?.email})`);
    }

    if (newTask.dueDate) {
      console.log(`📅 Due Date: ${newTask.dueDate.toLocaleDateString()}`);
    }
  },
});

parser.addCommand({
  name: 'task-list',
  description: 'List tasks with filtering options',
  options: [
    {
      name: 'project',
      short: 'p',
      type: 'number',
      description: 'Filter by project ID',
    },
    {
      name: 'status',
      short: 's',
      type: 'string',
      description: 'Filter by status',
      choices: ['todo', 'in-progress', 'completed'],
    },
    {
      name: 'priority',
      type: 'string',
      description: 'Filter by priority',
      choices: ['low', 'medium', 'high', 'critical'],
    },
    {
      name: 'assignee',
      short: 'a',
      type: 'number',
      description: 'Filter by assignee ID',
    },
    {
      name: 'overdue',
      type: 'boolean',
      description: 'Show only overdue tasks',
    },
  ],
  handler: async options => {
    let tasks = mockData.tasks;

    if (options.project) {
      const projectId =
        typeof options.project === 'number'
          ? options.project
          : parseInt(options.project.toString());
      tasks = tasks.filter(t => t.projectId === projectId);
    }

    if (options.status) {
      tasks = tasks.filter(t => t.status === options.status);
    }

    if (options.priority) {
      tasks = tasks.filter(t => t.priority === options.priority);
    }

    if (options.assignee) {
      const assigneeId =
        typeof options.assignee === 'number'
          ? options.assignee
          : parseInt(options.assignee.toString());
      tasks = tasks.filter(t => t.assigneeId === assigneeId);
    }

    if (options.overdue) {
      const now = new Date();
      tasks = tasks.filter(t => t.dueDate && t.dueDate < now && t.status !== 'completed');
    }

    console.log(`📋 Tasks (${tasks.length} found)`);
    console.log('='.repeat(60));

    tasks.forEach(task => {
      const project = mockData.projects.find(p => p.id === task.projectId);
      const assignee = task.assigneeId ? mockData.users.find(u => u.id === task.assigneeId) : null;

      console.log(`🆔 ${task.id}: ${task.title}`);
      console.log(`   📋 Project: ${project?.name || 'Unknown'}`);
      console.log(`   📄 ${task.description || 'No description'}`);
      console.log(`   ⚡ Priority: ${task.priority} | 📊 Status: ${task.status}`);

      if (assignee) {
        console.log(`   👤 Assignee: ${assignee.name}`);
      }

      if (task.dueDate) {
        const isOverdue = task.dueDate < new Date() && task.status !== 'completed';
        console.log(
          `   📅 Due: ${task.dueDate.toLocaleDateString()} ${isOverdue ? '⚠️ OVERDUE' : ''}`
        );
      }

      console.log('');
    });
  },
});

// User Management Commands
parser.addCommand({
  name: 'user-add',
  description: 'Add a new user',
  options: [
    {
      name: 'name',
      short: 'n',
      type: 'string',
      description: "User's full name",
      required: true,
    },
    {
      name: 'email',
      short: 'e',
      type: 'string',
      description: "User's email address",
      required: true,
      validator: value => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const email = value.toString();
        if (!emailRegex.test(email)) {
          return 'Invalid email format';
        }
        const existingUser = mockData.users.find(u => u.email === email);
        return existingUser ? 'Email already exists' : true;
      },
    },
    {
      name: 'role',
      short: 'r',
      type: 'string',
      description: "User's role",
      choices: ['admin', 'manager', 'developer', 'tester'],
      required: true,
    },
  ],
  handler: async options => {
    const newUser: User = {
      id: Math.max(...mockData.users.map(u => u.id), 0) + 1,
      name: options.name.toString(),
      email: options.email.toString(),
      role: options.role as 'admin' | 'manager' | 'developer' | 'tester',
      active: true,
      createdAt: new Date(),
    };

    mockData.users.push(newUser);

    console.log('✅ User created successfully!');
    console.log(`🆔 ID: ${newUser.id}`);
    console.log(`👤 Name: ${newUser.name}`);
    console.log(`📧 Email: ${newUser.email}`);
    console.log(`🎭 Role: ${newUser.role}`);
    console.log(`📅 Created: ${newUser.createdAt.toLocaleDateString()}`);
  },
});

// Reporting Commands
parser.addCommand({
  name: 'report',
  description: 'Generate various reports',
  options: [
    {
      name: 'type',
      short: 't',
      type: 'string',
      description: 'Report type',
      choices: ['summary', 'project-status', 'user-workload', 'overdue-tasks'],
      required: true,
    },
    {
      name: 'format',
      short: 'f',
      type: 'string',
      description: 'Output format',
      choices: ['text', 'json'],
      default: 'text',
    },
  ],
  handler: async options => {
    const reportType = options.type;
    const format = options.format || 'text';

    console.log(`📊 Generating ${reportType} report...`);
    console.log('='.repeat(50));

    switch (reportType) {
      case 'summary':
        const summary = {
          projects: {
            total: mockData.projects.length,
            active: mockData.projects.filter(p => p.status === 'active').length,
            completed: mockData.projects.filter(p => p.status === 'completed').length,
            archived: mockData.projects.filter(p => p.status === 'archived').length,
          },
          tasks: {
            total: mockData.tasks.length,
            todo: mockData.tasks.filter(t => t.status === 'todo').length,
            inProgress: mockData.tasks.filter(t => t.status === 'in-progress').length,
            completed: mockData.tasks.filter(t => t.status === 'completed').length,
          },
          users: {
            total: mockData.users.length,
            active: mockData.users.filter(u => u.active).length,
          },
        };

        if (format === 'json') {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log('📋 Projects:');
          console.log(`   Total: ${summary.projects.total}`);
          console.log(`   Active: ${summary.projects.active}`);
          console.log(`   Completed: ${summary.projects.completed}`);
          console.log(`   Archived: ${summary.projects.archived}`);

          console.log('\n📝 Tasks:');
          console.log(`   Total: ${summary.tasks.total}`);
          console.log(`   To Do: ${summary.tasks.todo}`);
          console.log(`   In Progress: ${summary.tasks.inProgress}`);
          console.log(`   Completed: ${summary.tasks.completed}`);

          console.log('\n👥 Users:');
          console.log(`   Total: ${summary.users.total}`);
          console.log(`   Active: ${summary.users.active}`);
        }
        break;

      case 'overdue-tasks':
        const now = new Date();
        const overdueTasks = mockData.tasks.filter(
          t => t.dueDate && t.dueDate < now && t.status !== 'completed'
        );

        console.log(`⚠️  Overdue Tasks (${overdueTasks.length} found):`);
        overdueTasks.forEach(task => {
          const project = mockData.projects.find(p => p.id === task.projectId);
          const assignee = task.assigneeId
            ? mockData.users.find(u => u.id === task.assigneeId)
            : null;
          const daysOverdue = Math.floor(
            (now.getTime() - task.dueDate!.getTime()) / (1000 * 60 * 60 * 24)
          );

          console.log(`   🆔 ${task.id}: ${task.title}`);
          console.log(`      📋 Project: ${project?.name}`);
          console.log(`      👤 Assignee: ${assignee?.name || 'Unassigned'}`);
          console.log(
            `      📅 Due: ${task.dueDate!.toLocaleDateString()} (${daysOverdue} days overdue)`
          );
          console.log('');
        });
        break;
    }
  },
});

// Configuration Commands
parser.addCommand({
  name: 'config',
  description: 'Manage application configuration',
  options: [
    {
      name: 'show',
      type: 'boolean',
      description: 'Show current configuration',
    },
    {
      name: 'set',
      type: 'string',
      description: 'Set configuration value (key=value)',
      multiple: true,
    },
    {
      name: 'reset',
      type: 'boolean',
      description: 'Reset to default configuration',
    },
  ],
  handler: async options => {
    const config = {
      dateFormat: 'MM/DD/YYYY',
      timezone: 'UTC',
      defaultPriority: 'medium',
      autoAssign: false,
      notifications: true,
    };

    if (options.show || (!options.set && !options.reset)) {
      console.log('⚙️  Current Configuration:');
      console.log('='.repeat(30));
      Object.entries(config).forEach(([key, value]) => {
        console.log(`${key}: ${value}`);
      });
    }

    if (options.set) {
      const settings = Array.isArray(options.set) ? options.set : [options.set];
      console.log('🔧 Setting configuration values:');
      settings.forEach(setting => {
        const [key, value] = setting.toString().split('=');
        console.log(`   ${key} = ${value}`);
      });
    }

    if (options.reset) {
      console.log('🔄 Configuration reset to defaults');
    }
  },
});

// Execute the parser
if (require.main === module) {
  parser.execute().catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
}

export { parser, mockData };
