-- ============================================================================
-- INTROSPECTION TEST DATABASE SCHEMA
-- ============================================================================
-- This schema is designed to test all PostgreSQL data types and scenarios
-- for the database introspection system
-- ============================================================================

\c introspect;

-- Create test schemas
CREATE SCHEMA IF NOT EXISTS public;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS analytics;

-- ============================================================================
-- PUBLIC SCHEMA - Main test tables
-- ============================================================================

-- Test table: All primitive types
CREATE TABLE public.users (
    -- Primary key
    id SERIAL PRIMARY KEY,
    
    -- String types
    username VARCHAR(50) NOT NULL,
    email TEXT NOT NULL,
    first_name CHARACTER(50),
    last_name CHARACTER VARYING(100),
    
    -- Numeric types
    age INTEGER,
    height SMALLINT,
    weight BIGINT,
    balance NUMERIC(10, 2),
    score DECIMAL(5, 2),
    rating REAL,
    precision_value DOUBLE PRECISION,
    
    -- Boolean
    is_active BOOLEAN DEFAULT true,
    is_verified BOOLEAN,
    
    -- Date/Time types
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE,
    last_login TIMESTAMP WITH TIME ZONE,
    birth_date DATE,
    login_time TIME,
    login_time_tz TIME WITH TIME ZONE,
    
    -- JSON types
    metadata JSONB,
    settings JSON,
    
    -- UUID
    external_id UUID,
    
    -- Array types
    tags TEXT[],
    scores INTEGER[],
    
    -- Special types
    ip_address INET,
    mac_address MACADDR,
    
    -- Nullable columns (for testing nullable handling)
    bio TEXT,
    website VARCHAR(255),
    phone VARCHAR(20)
);

-- Test table: Posts with foreign key (but we won't generate relationships)
CREATE TABLE public.posts (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    content TEXT,
    excerpt TEXT,
    author_id INTEGER NOT NULL,
    category_id SMALLINT,
    view_count BIGINT DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    is_published BOOLEAN DEFAULT false,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Test table: Snake case names (to test name conversion)
CREATE TABLE public.user_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    display_name VARCHAR(100),
    avatar_url TEXT,
    cover_image_url TEXT,
    bio_html TEXT,
    social_links JSONB,
    preferences JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Test table: Complex JSONB columns
CREATE TABLE public.products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(50) UNIQUE NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    cost NUMERIC(10, 2),
    
    -- JSONB columns for custom mapping tests
    specifications JSONB,
    attributes JSONB,
    metadata JSONB,
    
    stock_quantity INTEGER DEFAULT 0,
    is_available BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Test table: All nullable columns
CREATE TABLE public.optional_data (
    id SERIAL PRIMARY KEY,
    optional_string VARCHAR(100),
    optional_number INTEGER,
    optional_boolean BOOLEAN,
    optional_date TIMESTAMP,
    optional_json JSONB,
    optional_array TEXT[]
);

-- Test table: All NOT NULL columns
CREATE TABLE public.required_data (
    id SERIAL PRIMARY KEY,
    required_string VARCHAR(100) NOT NULL,
    required_number INTEGER NOT NULL,
    required_boolean BOOLEAN NOT NULL,
    required_date TIMESTAMP NOT NULL,
    required_json JSONB NOT NULL
);

-- Test table: Default values
CREATE TABLE public.defaults_test (
    id SERIAL PRIMARY KEY,
    string_default VARCHAR(50) DEFAULT 'default_value',
    number_default INTEGER DEFAULT 42,
    boolean_default BOOLEAN DEFAULT true,
    timestamp_default TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    json_default JSONB DEFAULT '{}'::jsonb,
    array_default TEXT[] DEFAULT ARRAY[]::TEXT[]
);

-- Test table: Numeric precision and scale
CREATE TABLE public.numeric_types (
    id SERIAL PRIMARY KEY,
    decimal_5_2 DECIMAL(5, 2),
    decimal_10_4 DECIMAL(10, 4),
    numeric_8_3 NUMERIC(8, 3),
    numeric_15_6 NUMERIC(15, 6),
    money_type MONEY,
    float4_type FLOAT4,
    float8_type FLOAT8
);

-- Test table: Character types with different lengths
CREATE TABLE public.string_types (
    id SERIAL PRIMARY KEY,
    char_10 CHAR(10),
    varchar_50 VARCHAR(50),
    varchar_255 VARCHAR(255),
    text_unlimited TEXT,
    char_varying_100 CHARACTER VARYING(100)
);

-- Test view: Simple view
CREATE VIEW public.active_users AS
SELECT 
    id,
    username,
    email,
    is_active,
    created_at
FROM public.users
WHERE is_active = true;

-- Test view: Complex view with joins
CREATE VIEW public.user_post_summary AS
SELECT 
    u.id as user_id,
    u.username,
    COUNT(p.id) as post_count,
    MAX(p.created_at) as last_post_date
FROM public.users u
LEFT JOIN public.posts p ON u.id = p.author_id
GROUP BY u.id, u.username;

-- ============================================================================
-- AUTH SCHEMA - Test schema scoping
-- ============================================================================

-- Same table name as public.users but in different schema
CREATE TABLE auth.users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    is_admin BOOLEAN DEFAULT false,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth.refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ANALYTICS SCHEMA - Additional test schema
-- ============================================================================

CREATE TABLE analytics.events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    user_id INTEGER,
    session_id UUID,
    properties JSONB,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE analytics.page_views (
    id BIGSERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    referrer TEXT,
    user_id INTEGER,
    session_id UUID,
    duration_seconds INTEGER,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- INDEXES (for completeness, though we don't introspect them yet)
-- ============================================================================

CREATE INDEX idx_users_email ON public.users(email);
CREATE INDEX idx_users_username ON public.users(username);
CREATE INDEX idx_posts_author ON public.posts(author_id);
CREATE INDEX idx_posts_published ON public.posts(is_published, published_at);
CREATE INDEX idx_user_profiles_user ON public.user_profiles(user_id);

-- ============================================================================
-- SAMPLE DATA (for testing)
-- ============================================================================

INSERT INTO public.users (
    username, email, first_name, last_name, age, is_active, 
    metadata, tags, bio
) VALUES 
(
    'john_doe', 
    'john@example.com', 
    'John', 
    'Doe', 
    30, 
    true,
    '{"theme": "dark", "language": "en"}'::jsonb,
    ARRAY['developer', 'blogger'],
    'Software developer and tech enthusiast'
),
(
    'jane_smith',
    'jane@example.com',
    'Jane',
    'Smith',
    28,
    true,
    '{"theme": "light", "language": "es"}'::jsonb,
    ARRAY['designer', 'artist'],
    NULL
),
(
    'inactive_user',
    'inactive@example.com',
    'Inactive',
    'User',
    25,
    false,
    NULL,
    NULL,
    NULL
);

INSERT INTO public.posts (
    title, slug, content, author_id, is_published, published_at
) VALUES
(
    'First Post',
    'first-post',
    'This is the content of the first post',
    1,
    true,
    CURRENT_TIMESTAMP
),
(
    'Draft Post',
    'draft-post',
    'This is a draft',
    1,
    false,
    NULL
);

INSERT INTO auth.users (email, password_hash, salt, is_admin) VALUES
('admin@example.com', 'hash123', 'salt123', true),
('user@example.com', 'hash456', 'salt456', false);

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- This schema provides comprehensive coverage for:
-- 1. All PostgreSQL primitive types (string, numeric, boolean, date/time)
-- 2. Complex types (JSON, JSONB, arrays, UUID)
-- 3. Nullable vs NOT NULL columns
-- 4. Default values
-- 5. Multiple schemas (public, auth, analytics)
-- 6. Views (simple and complex)
-- 7. Snake_case table names
-- 8. Various numeric precisions and scales
-- 9. Different string length constraints
-- 10. Same table names in different schemas (scoping test)
-- ============================================================================
