# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
# dawters-plughost — the VST3 host helper. Needs the Steinberg VST3 SDK (MIT license):
#   git clone --depth 1 --branch v3.8.1_build_84 --recursive https://github.com/steinbergmedia/vst3sdk.git
#   cmake -S native/plughost -B build/plughost -DVST3_SDK_ROOT=/path/to/vst3sdk -DCMAKE_BUILD_TYPE=Release
#   cmake --build build/plughost --config Release
cmake_minimum_required (VERSION 3.25.0)

if(NOT DEFINED ENV{MACOSX_DEPLOYMENT_TARGET})
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "macOS deployment target")
endif()

project(dawters_plughost VERSION 1.0.0 LANGUAGES C CXX)
if(APPLE)
    enable_language(OBJCXX)
endif()

set(VST3_SDK_ROOT "" CACHE PATH "Path to the VST3 SDK checkout")
if(NOT EXISTS "${VST3_SDK_ROOT}/pluginterfaces")
    message(FATAL_ERROR "Set VST3_SDK_ROOT to a checkout of https://github.com/steinbergmedia/vst3sdk (tag v3.8.1_build_84)")
endif()

# only the SDK's libraries: no example plug-ins, hosts or VSTGUI
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_AUV2_BUILDS OFF CACHE BOOL "" FORCE)
set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
add_subdirectory ("${VST3_SDK_ROOT}" vst3sdk EXCLUDE_FROM_ALL)

set(SOURCES
    src/main.cpp
    src/json.h
    src/ui.h
    "${VST3_SDK_ROOT}/public.sdk/source/common/memorystream.cpp"
    "${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
)
if(APPLE)
    list(APPEND SOURCES src/ui_mac.mm "${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm")
    set_source_files_properties ("${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm" PROPERTIES COMPILE_FLAGS "-fobjc-arc")
elseif(WIN32)
    list(APPEND SOURCES src/ui_win.cpp src/plughost.rc "${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp")
else()
    list(APPEND SOURCES src/ui_linux.cpp "${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp")
endif()

add_executable (dawters-plughost ${SOURCES})
target_compile_features (dawters-plughost PRIVATE cxx_std_17)
target_include_directories (dawters-plughost PRIVATE "${VST3_SDK_ROOT}")
target_link_libraries (dawters-plughost PRIVATE sdk_hosting sdk_common)

if(APPLE)
    set_source_files_properties (src/ui_mac.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
    target_link_libraries (dawters-plughost PRIVATE "-framework Cocoa" "-framework CoreFoundation")
elseif(WIN32)
    target_compile_definitions (dawters-plughost PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
    target_link_libraries (dawters-plughost PRIVATE ole32 user32 shell32)
    set_property (TARGET dawters-plughost PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
    # a GUI-subsystem program would detach from the pipes; keep it a console program with no console window
    # (Electron starts it with windowsHide)
else()
    find_package (Threads REQUIRED)
    target_link_libraries (dawters-plughost PRIVATE Threads::Threads ${CMAKE_DL_LIBS})
endif()
